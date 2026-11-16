import { Minus, Plus } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { Spinner } from '@/components/common/Spinner';
import { Tags } from '@/components/common/Tags';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FieldMessage, fieldProps } from '@/components/ui/field-message';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Textarea } from '@/components/ui/textarea';
import { verifyOllamaConnection } from '@/lib/apis/ollama';
import { verifyOpenAIConnection } from '@/lib/apis/openai';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfirmLeave } from '@/lib/ui/useUnsavedChanges';
import {
	blankFields,
	buildConnection,
	type Connection,
	type ConnectionField,
	type ConnectionFields,
	fieldsFromConnection,
	isAzure,
	modelListResult,
	parseHeaders,
	type TestResult,
	urlProblem,
	validateConnection,
	verifyConfig
} from './connectionModel';
import {
	ConnectionUrlField,
	Disclosure,
	FieldLabel,
	FormField,
	SecretInput,
	SelectField,
	SwitchField
} from './formFields';

const SUGGESTIONS = [
	'https://api.openai.com/v1',
	'https://api.anthropic.com/v1',
	'https://generativelanguage.googleapis.com/v1beta/openai',
	'https://api.mistral.ai/v1',
	'https://api.groq.com/openai/v1',
	'https://openrouter.ai/api/v1',
	'https://api.x.ai/v1'
];

const AUTH_HELP: Record<string, string> = {
	none: 'Requests go without credentials.',
	session: "Sends the signed-in user's session credentials.",
	system_oauth: "Sends the signed-in user's OAuth access token.",
	microsoft_entra_id: 'Uses DefaultAzureCredential.',
	azure_ad: 'Uses DefaultAzureCredential.'
};

const PROVIDERS = [
	['', 'Default'],
	['azure', 'Azure OpenAI'],
	['llama.cpp', 'llama.cpp'],
	['lmstudio', 'LM Studio'],
	['litellm', 'LiteLLM']
] as const;

/** A thrown verify error, as a sentence: the API helpers throw the server's words, some still prefixed. */
const causeText = (error: unknown) => `${error}`.replace(/^(OpenAI|Ollama): /, '');

type Errors = Partial<Record<ConnectionField | 'headers', string>>;

/**
 * Ports components/AddConnectionModal.svelte: add or edit one upstream (an
 * OpenAI-compatible server, an Ollama server, or -- with `direct` -- a user's
 * own endpoint). It tests the connection on request and hands the finished
 * `{ url, key, config }` to `onSubmit`; the caller decides what saving means.
 * The rules live in connectionModel.ts.
 *
 * #933: one form language, the shared fields with their labels above and
 * their lines under (FRM-1, FRM-2); the two-way choices as segmented controls
 * (FRM-4); Advanced behind a chevron disclosure (FRM-6). #1018: Test
 * connection sits beside the URL and says what it found under it (FBK-1).
 * Save checks the form and says what is wrong under the field at fault,
 * opening Advanced when that is where it is.
 */
export function AddConnectionModal({
	open,
	onOpenChange,
	edit = false,
	ollama = false,
	direct = false,
	connection = null,
	onSubmit,
	onDelete
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	edit?: boolean;
	ollama?: boolean;
	direct?: boolean;
	connection?: Connection | null;
	onSubmit: (connection: Connection) => void | Promise<void>;
	onDelete?: () => void | Promise<void>;
}) {
	const token = useAuthStore((s) => s.token) ?? '';
	const ids = useId();
	const id = (name: string) => `${ids}-${name}`;
	const [f, setF] = useState<ConnectionFields>(blankFields());
	const [modelId, setModelId] = useState('');
	const [showAdvanced, setShowAdvanced] = useState(false);
	const [errors, setErrors] = useState<Errors>({});
	const [loading, setLoading] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);
	// FRM-3: what the dialog opened with; Escape, the scrim and × ask before losing a change to it.
	const [initial, setInitial] = useState<string | null>(null);
	const dirty = open && initial !== null && (JSON.stringify(f) !== initial || modelId.trim() !== '');
	const guard = useConfirmLeave(dirty, {
		message: edit
			? 'The changes to this connection are not saved. They are lost if you close it.'
			: 'This connection is not added yet. What you entered is lost if you close it.'
	});
	const close = () => guard.confirmLeave(() => onOpenChange(false));
	const mode = { ollama, direct };
	const azure = isAzure(f.provider, f.url, direct);
	const set = (patch: Partial<ConnectionFields>) => {
		setF((prev) => ({ ...prev, ...patch }));
		// An edit to a field clears what was said about it.
		setErrors((prev) => {
			const next = { ...prev };
			for (const key of Object.keys(patch)) delete next[key as keyof Errors];
			return next;
		});
	};

	useEffect(() => {
		if (!open) {
			setInitial(null);
			return;
		}
		const start = fieldsFromConnection(connection, { ollama });
		setF(start);
		setInitial(JSON.stringify(start));
		setModelId('');
		setShowAdvanced(false);
		setErrors({});
		setLoading(false);
		// Seeded when the dialog opens; edits inside it are local.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	/** The headers as an object, or null after saying under the field why they are not one. */
	const checkedHeaders = () => {
		try {
			const { value, text } = parseHeaders(f.headers);
			setF((prev) => ({ ...prev, headers: text }));
			return { ok: true as const, value };
		} catch {
			setShowAdvanced(true);
			setErrors((prev) => ({ ...prev, headers: 'Enter the headers as a JSON object, or leave them empty.' }));
			return { ok: false as const, value: null };
		}
	};

	const test = async (): Promise<TestResult | null> => {
		const url = f.url.trim().replace(/\/$/, '');
		const problem = urlProblem(url);
		if (problem) return { ok: false, text: problem };
		setF((prev) => ({ ...prev, url }));
		try {
			if (ollama) {
				const res = await verifyOllamaConnection(token, { url, key: f.key });
				const version = (res as { version?: string } | null)?.version;
				return { ok: true, text: version ? `Reachable: Ollama ${version}` : 'Reachable' };
			}
			const headers = checkedHeaders();
			if (!headers.ok) return null;
			const res = await verifyOpenAIConnection(
				token,
				{ url, key: f.key, config: verifyConfig({ ...f, url }, mode, headers.value) },
				direct
			);
			return modelListResult(res);
		} catch (error) {
			return { ok: false, text: causeText(error) };
		}
	};

	const addModel = () => {
		const value = modelId.trim();
		if (!value) return;
		if (f.modelIds.includes(value)) {
			toast.error(`“${value}” is already in the list.`);
			return;
		}
		set({ modelIds: [...f.modelIds, value] });
		setModelId('');
	};

	const submit = async () => {
		const problem = validateConnection(f, mode);
		if (problem) {
			if (problem.openAdvanced) setShowAdvanced(true);
			setErrors({ [problem.field]: problem.message });
			// After the render that shows it (and opens Advanced), so the field exists.
			setTimeout(() => document.getElementById(id(problem.field))?.focus());
			return;
		}
		const headers = checkedHeaders();
		if (!headers.ok) return;
		setLoading(true);
		try {
			await onSubmit(buildConnection(f, mode, headers.value));
		} catch {
			// The caller has said why; the dialog stays open with what was entered.
			return;
		} finally {
			setLoading(false);
		}
		onOpenChange(false);
	};

	const authOptions: [string, string][] = [
		['none', 'None'],
		['bearer', 'API key (Bearer)'],
		...(ollama
			? []
			: ([
					['session', 'Session'],
					...(direct
						? []
						: [
								['system_oauth', 'OAuth'],
								['microsoft_entra_id', 'Entra ID']
							])
				] as [string, string][]))
	];
	const modelsHelp = ollama
		? `Empty: every model the server lists at ${f.url || 'its URL'}/api/tags.`
		: azure
			? 'Azure OpenAI needs its deployment names here.'
			: `Empty: every model the server lists at ${f.url || 'its URL'}/models.`;

	return (
		<>
			<ConfirmDialog
				open={confirmDelete}
				onOpenChange={setConfirmDelete}
				title={`Delete “${f.url || 'this connection'}”?`}
				confirmLabel="Delete connection"
				destructive
				onConfirm={async () => {
					setConfirmDelete(false);
					await onDelete?.();
					onOpenChange(false);
				}}
			>
				Its models disappear from the model picker, and chats that use them stop getting replies. This can't be undone.
			</ConfirmDialog>

			<Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
				<DialogContent className="sm:max-w-lg">
					{guard.dialog}
					<DialogHeader>
						<DialogTitle>{edit ? 'Edit connection' : 'Add connection'}</DialogTitle>
						<DialogDescription>
							{ollama
								? 'An Ollama server.'
								: direct
									? 'An OpenAI-compatible server your browser talks to directly.'
									: 'An OpenAI-compatible server: OpenRouter, or llama-server on :8090.'}
						</DialogDescription>
					</DialogHeader>
					<form
						noValidate
						className="flex flex-col gap-4"
						onSubmit={(e) => {
							e.preventDefault();
							void submit();
						}}
					>
						{!direct && (
							<div className="flex flex-col">
								<FieldLabel>
									<span id={id('type-label')}>Connection type</span>
								</FieldLabel>
								<SegmentedControl
									aria-labelledby={id('type-label')}
									aria-describedby={id('type-help')}
									value={f.connectionType === 'local' ? 'local' : 'external'}
									onValueChange={(connectionType) => set({ connectionType })}
									options={[
										{ value: 'external', label: 'External' },
										{ value: 'local', label: 'Local' }
									]}
									className="self-start"
								/>
								<FieldMessage
									id={id('type-help')}
									className="mt-1.5"
									help="A chat on one of its models uses the local or the external task model."
								/>
							</div>
						)}

						<ConnectionUrlField
							id={id('url')}
							value={f.url}
							onChange={(url) => set({ url })}
							placeholder={ollama ? 'http://localhost:11434' : 'https://openrouter.ai/api/v1'}
							list={ollama ? undefined : id('suggestions')}
							error={errors.url}
							onTest={test}
						/>
						{!ollama && (
							<datalist id={id('suggestions')}>
								{SUGGESTIONS.map((s) => (
									<option key={s} value={s} />
								))}
							</datalist>
						)}

						<SwitchField
							id={id('enable')}
							label="Enabled"
							checked={f.enable}
							onCheckedChange={(enable) => set({ enable })}
						/>

						<FormField id={id('auth')} label="Authentication" help={AUTH_HELP[f.authType]}>
							{(props) => (
								<SelectField
									{...props}
									className="sm:w-60"
									value={f.authType}
									onChange={(authType) => set({ authType })}
									options={authOptions}
								/>
							)}
						</FormField>
						{f.authType === 'bearer' && (
							<FormField id={id('key')} label="API key" optional={!azure} error={errors.key}>
								{(props) => <SecretInput {...props} value={f.key} onChange={(key) => set({ key })} />}
							</FormField>
						)}

						{!ollama && !direct && (
							<div className="flex flex-col">
								<FieldLabel>
									<span id={id('api-label')}>API type</span>
								</FieldLabel>
								<SegmentedControl
									aria-labelledby={id('api-label')}
									value={f.apiType === 'responses' ? 'responses' : 'chat'}
									onValueChange={(v) => set({ apiType: v === 'responses' ? 'responses' : '' })}
									options={[
										{ value: 'chat', label: 'Chat Completions' },
										{ value: 'responses', label: 'Responses' }
									]}
									className="self-start"
								/>
							</div>
						)}

						<Disclosure title="Advanced" open={showAdvanced} onOpenChange={setShowAdvanced}>
							<div className="flex flex-col gap-4">
								{!direct && (
									<FormField
										id={id('headers')}
										label="Headers"
										optional
										help='A JSON object, such as {"X-Custom-Header": "value"}.'
										error={errors.headers}
									>
										{(props) => (
											<Textarea
												{...props}
												className="font-mono"
												value={f.headers}
												onChange={(e) => set({ headers: e.target.value })}
											/>
										)}
									</FormField>
								)}
								{!ollama && !direct && (
									<FormField
										id={id('passthrough')}
										label="Passthrough parameters"
										optional
										help="Top-level request parameters this server may receive as they are, separated by commas. * allows every one."
									>
										{(props) => (
											<Input
												{...props}
												value={f.passthroughParams}
												onChange={(e) => set({ passthroughParams: e.target.value })}
												placeholder="thinking, output_config"
												autoComplete="off"
											/>
										)}
									</FormField>
								)}
								<FormField
									id={id('prefix')}
									label="Prefix ID"
									optional
									help="Added in front of this server's model IDs, so they can't clash with another connection's."
								>
									{(props) => (
										<Input
											{...props}
											value={f.prefixId}
											onChange={(e) => set({ prefixId: e.target.value })}
											autoComplete="off"
										/>
									)}
								</FormField>
								{!ollama && !direct && (
									<FormField id={id('provider')} label="Provider">
										{(props) => (
											<SelectField
												{...props}
												className="sm:w-60"
												value={f.provider}
												onChange={(provider) => set({ provider })}
												options={PROVIDERS}
											/>
										)}
									</FormField>
								)}
								{azure && (
									<FormField id={id('apiVersion')} label="API version" error={errors.apiVersion}>
										{(props) => (
											<Input
												{...props}
												value={f.apiVersion}
												onChange={(e) => set({ apiVersion: e.target.value })}
												placeholder="2024-10-21"
												autoComplete="off"
											/>
										)}
									</FormField>
								)}
								<div className="flex flex-col">
									<FieldLabel htmlFor={id('modelIds')} optional={!azure}>
										Model IDs
									</FieldLabel>
									{f.modelIds.length > 0 && (
										<ul className="mb-2 flex flex-col gap-1">
											{f.modelIds.map((m) => (
												<li key={m} className="flex min-w-0 items-center justify-between gap-2 text-body">
													<span className="min-w-0 truncate font-mono">{m}</span>
													<Button
														variant="ghost"
														size="icon-sm"
														type="button"
														aria-label={`Remove ${m}`}
														onClick={() => set({ modelIds: f.modelIds.filter((x) => x !== m) })}
													>
														<Minus aria-hidden />
													</Button>
												</li>
											))}
										</ul>
									)}
									<div className="flex items-center gap-2">
										<Input
											id={id('modelIds')}
											value={modelId}
											onChange={(e) => setModelId(e.target.value)}
											onKeyDown={(e) => {
												// Enter here adds the model, it must not submit the connection.
												if (e.key === 'Enter') {
													e.preventDefault();
													addModel();
												}
											}}
											placeholder="Add a model ID"
											{...fieldProps(id('modelIds-message'), { error: errors.modelIds, help: modelsHelp })}
										/>
										<Button variant="outline" size="icon" type="button" aria-label="Add model ID" onClick={addModel}>
											<Plus aria-hidden />
										</Button>
									</div>
									<FieldMessage
										id={id('modelIds-message')}
										className="mt-1.5"
										error={errors.modelIds}
										help={modelsHelp}
									/>
								</div>
								<div className="flex flex-col">
									<FieldLabel htmlFor={id('tags')} optional>
										Tags
									</FieldLabel>
									<Tags
										id={id('tags')}
										tags={f.tags}
										onAdd={(name) => set({ tags: [...f.tags, { name }] })}
										onDelete={(name) => set({ tags: f.tags.filter((t) => t.name !== name) })}
									/>
								</div>
							</div>
						</Disclosure>

						<div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
							<div>
								{edit && (
									<Button type="button" variant="destructive" onClick={() => setConfirmDelete(true)}>
										Delete connection
									</Button>
								)}
							</div>
							<Button type="submit" disabled={loading} aria-busy={loading || undefined}>
								{loading && <Spinner className="size-3.5" />}
								{loading ? 'Saving…' : 'Save'}
							</Button>
						</div>
					</form>
				</DialogContent>
			</Dialog>
		</>
	);
}
