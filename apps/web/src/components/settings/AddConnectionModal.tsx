import { Check, Minus, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { SensitiveInput } from '@/components/common/SensitiveInput';
import { Spinner } from '@/components/common/Spinner';
import { Tags } from '@/components/common/Tags';
import { Tip } from '@/components/common/Tip';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { verifyOllamaConnection } from '@/lib/apis/ollama';
import { verifyOpenAIConnection } from '@/lib/apis/openai';
import { useAuthStore } from '@/lib/stores/authStore';
import {
	type Connection,
	type ConnectionFields,
	blankFields,
	buildConnection,
	fieldsFromConnection,
	isAzure,
	parseHeaders,
	validateConnection,
	verifyConfig
} from './connectionModel';

const SUGGESTIONS = [
	'https://api.openai.com/v1',
	'https://api.anthropic.com/v1',
	'https://generativelanguage.googleapis.com/v1beta/openai',
	'https://api.mistral.ai/v1',
	'https://api.groq.com/openai/v1',
	'https://openrouter.ai/api/v1',
	'https://api.x.ai/v1'
];

const bare = 'w-full bg-transparent text-sm outline-hidden placeholder:text-muted-foreground/50';
const label = 'text-muted-foreground text-xs';

/**
 * Ports components/AddConnectionModal.svelte: add or edit one upstream (an
 * OpenAI-compatible server, an Ollama server, or -- with `direct` -- a user's
 * own endpoint). It verifies the connection on request and hands the finished
 * `{ url, key, config }` to `onSubmit`; the caller decides what saving means.
 * The rules live in connectionModel.ts.
 *
 * Every open starts from `connection` (or blank), where the Svelte modal keeps its
 * last values between opens; and a header field that is not valid JSON no longer
 * leaves the Save button spinning (the original returns without clearing `loading`).
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
	const [f, setF] = useState<ConnectionFields>(blankFields());
	const [modelId, setModelId] = useState('');
	const [showAdvanced, setShowAdvanced] = useState(false);
	const [loading, setLoading] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const mode = { ollama, direct };
	const set = (patch: Partial<ConnectionFields>) => setF((prev) => ({ ...prev, ...patch }));
	const azure = isAzure(f.provider, f.url, direct);

	useEffect(() => {
		if (!open) return;
		setF(fieldsFromConnection(connection, { ollama }));
		setModelId('');
		setShowAdvanced(false);
		setLoading(false);
		// Seeded when the dialog opens; edits inside it are local.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	const headersOrToast = () => {
		try {
			const { value, text } = parseHeaders(f.headers);
			set({ headers: text });
			return { ok: true as const, value };
		} catch {
			toast.error('Headers must be a valid JSON object');
			return { ok: false as const, value: null };
		}
	};

	const verify = async () => {
		const url = f.url.replace(/\/$/, '');
		set({ url });
		if (ollama) {
			const res = await verifyOllamaConnection(token, { url, key: f.key }).catch((error) => toast.error(`${error}`));
			if (res) toast.success('Server connection verified');
			return;
		}
		const headers = headersOrToast();
		if (!headers.ok) return;
		const res = await verifyOpenAIConnection(token, { url, key: f.key, config: verifyConfig({ ...f, url }, mode, headers.value) }, direct).catch((error) => toast.error(`${error}`));
		if (res) toast.success('Server connection verified');
	};

	const addModel = () => {
		const id = modelId.trim();
		if (!id) return;
		if (f.modelIds.includes(id)) {
			toast.error('Model ID is already added');
			return;
		}
		set({ modelIds: [...f.modelIds, id] });
		setModelId('');
	};

	const submit = async () => {
		const problem = validateConnection(f, mode);
		if (problem) {
			if (problem.openAdvanced) setShowAdvanced(true);
			toast.error(problem.message);
			return;
		}
		const headers = headersOrToast();
		if (!headers.ok) return;
		setLoading(true);
		try {
			await onSubmit(buildConnection(f, mode, headers.value));
		} finally {
			setLoading(false);
		}
		onOpenChange(false);
	};

	return (
		<>
			<ConfirmDialog
				open={confirmDelete}
				onOpenChange={setConfirmDelete}
				title="Delete connection?"
				confirmLabel="Delete"
				onConfirm={async () => {
					setConfirmDelete(false);
					await onDelete?.();
					onOpenChange(false);
				}}
			>
				Are you sure you want to delete this connection? This action cannot be undone.
			</ConfirmDialog>

			<Dialog open={open} onOpenChange={onOpenChange}>
				<DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
					<DialogHeader>
						<DialogTitle className="text-sm font-medium">{edit ? 'Edit Connection' : 'Add Connection'}</DialogTitle>
						<DialogDescription className="sr-only">An upstream model server.</DialogDescription>
					</DialogHeader>
					<form
						className="flex flex-col gap-2.5"
						onSubmit={(e) => {
							e.preventDefault();
							submit();
						}}
					>
						{!direct && (
							<div className="flex items-center justify-between">
								<div className={label}>Connection Type</div>
								<button
									type="button"
									className="text-xs underline-offset-2 hover:underline"
									onClick={() => set({ connectionType: f.connectionType === 'local' ? 'external' : 'local' })}
								>
									{f.connectionType === 'local' ? 'Local' : 'External'}
								</button>
							</div>
						)}

						<div className="flex items-end gap-2">
							<div className="min-w-0 flex-1">
								<label className={label} htmlFor="url-input">
									URL
								</label>
								<input
									id="url-input"
									className={bare}
									type="text"
									value={f.url}
									onChange={(e) => set({ url: e.target.value })}
									placeholder="API Base URL"
									autoComplete="off"
									list={ollama ? undefined : 'connection-url-suggestions'}
									required
								/>
								{!ollama && (
									<datalist id="connection-url-suggestions">
										{SUGGESTIONS.map((s) => (
											<option key={s} value={s} />
										))}
									</datalist>
								)}
							</div>
							<Tip content="Verify Connection">
								<button type="button" aria-label="Verify Connection" className="hover:bg-muted mb-0.5 rounded p-1 transition" onClick={verify}>
									<Check className="size-4" />
								</button>
							</Tip>
							<div className="mb-0.5 flex items-center" title={f.enable ? 'Enabled' : 'Disabled'}>
								<label className="sr-only" htmlFor="toggle-connection">
									Toggle whether current connection is active.
								</label>
								<Switch id="toggle-connection" checked={f.enable} onCheckedChange={(enable) => set({ enable })} />
							</div>
						</div>

						<div>
							<label className={label} htmlFor="select-bearer-or-session">
								Auth
							</label>
							<div className="flex items-center gap-2">
								<select id="select-bearer-or-session" className="bg-transparent pr-5 text-sm outline-hidden [&>option]:bg-popover" value={f.authType} onChange={(e) => set({ authType: e.target.value })}>
									<option value="none">None</option>
									<option value="bearer">Bearer</option>
									{!ollama && (
										<>
											<option value="session">Session</option>
											{!direct && (
												<>
													<option value="system_oauth">OAuth</option>
													<option value="microsoft_entra_id">Entra ID</option>
												</>
											)}
										</>
									)}
								</select>
								<div className="min-w-0 flex-1 text-sm">
									{f.authType === 'bearer' ? (
										<SensitiveInput value={f.key} onChange={(key) => set({ key })} placeholder="API Key" required={false} />
									) : f.authType === 'none' ? (
										<div className="text-muted-foreground text-xs">No authentication</div>
									) : f.authType === 'session' ? (
										<div className="text-muted-foreground text-xs">Forwards system user session credentials to authenticate</div>
									) : f.authType === 'system_oauth' ? (
										<div className="text-muted-foreground text-xs">Forwards system user OAuth access token to authenticate</div>
									) : ['azure_ad', 'microsoft_entra_id'].includes(f.authType) ? (
										<div className="text-muted-foreground text-xs">Uses DefaultAzureCredential to authenticate</div>
									) : null}
								</div>
							</div>
						</div>

						{!ollama && !direct && (
							<div className="flex items-center justify-between">
								<label className={label} htmlFor="api-type-toggle">
									API Type
								</label>
								<button id="api-type-toggle" type="button" className="text-xs underline-offset-2 hover:underline" onClick={() => set({ apiType: f.apiType === 'responses' ? '' : 'responses' })}>
									{f.apiType === 'responses' ? 'Responses' : 'Chat Completions'}
								</button>
							</div>
						)}

						<button type="button" className="text-muted-foreground hover:text-foreground w-fit text-xs" aria-expanded={showAdvanced} onClick={() => setShowAdvanced((v) => !v)}>
							{showAdvanced ? '▾' : '▸'} Advanced
						</button>

						{showAdvanced && (
							<>
								{!direct && (
									<div>
										<label className={label} htmlFor="headers-input">
											Headers
										</label>
										<Tip content='Enter additional headers in JSON format (e.g. {"X-Custom-Header": "value"}'>
											<textarea id="headers-input" className={`${bare} min-h-8 resize-y`} value={f.headers} onChange={(e) => set({ headers: e.target.value })} placeholder="Enter additional headers in JSON format" />
										</Tip>
									</div>
								)}
								{!ollama && !direct && (
									<div>
										<label className={label} htmlFor="allowed-passthrough-params-input">
											Passthrough params
										</label>
										<Tip content="Comma-separated top-level request parameters this upstream may receive without translation. Use * to allow all captured passthrough params.">
											<input id="allowed-passthrough-params-input" className={bare} type="text" value={f.passthroughParams} onChange={(e) => set({ passthroughParams: e.target.value })} placeholder="thinking, output_config" autoComplete="off" />
										</Tip>
									</div>
								)}
								<div>
									<label className={label} htmlFor="prefix-id-input">
										Prefix ID
									</label>
									<Tip content="Prefix ID is used to avoid conflicts with other connections by adding a prefix to the model IDs - leave empty to disable">
										<input id="prefix-id-input" className={bare} type="text" value={f.prefixId} onChange={(e) => set({ prefixId: e.target.value })} placeholder="Prefix ID" autoComplete="off" />
									</Tip>
								</div>
								{!ollama && !direct && (
									<div>
										<label className={label} htmlFor="provider-select">
											Provider
										</label>
										<select id="provider-select" className="block bg-transparent text-sm outline-hidden [&>option]:bg-popover" value={f.provider} onChange={(e) => set({ provider: e.target.value })}>
											<option value="">Default</option>
											<option value="azure">Azure OpenAI</option>
											<option value="llama.cpp">llama.cpp</option>
											<option value="lmstudio">LM Studio</option>
											<option value="litellm">LiteLLM</option>
										</select>
									</div>
								)}
								{azure && (
									<div>
										<label className={label} htmlFor="api-version-input">
											API Version
										</label>
										<input id="api-version-input" className={bare} type="text" value={f.apiVersion} onChange={(e) => set({ apiVersion: e.target.value })} placeholder="API Version" autoComplete="off" required />
									</div>
								)}
								<div>
									<div className={label}>Model IDs</div>
									{f.modelIds.length > 0 ? (
										<ul className="mt-1 flex flex-col gap-1">
											{f.modelIds.map((id) => (
												<li key={id} className="flex items-center justify-between text-xs">
													<div className="min-w-0 truncate">{id}</div>
													<button type="button" aria-label={`Remove ${id} from list.`} className="hover:bg-muted rounded p-0.5" onClick={() => set({ modelIds: f.modelIds.filter((x) => x !== id) })}>
														<Minus className="size-3.5" strokeWidth={2} />
													</button>
												</li>
											))}
										</ul>
									) : (
										<div className="text-muted-foreground mt-1 text-xs">
											{ollama
												? `Leave empty to include all models from "${f.url}/api/tags" endpoint`
												: azure
													? 'Deployment names are required for Azure OpenAI'
													: `Leave empty to include all models from "${f.url}/models" endpoint`}
										</div>
									)}
								</div>
								<div className="flex items-center gap-2">
									<label className="sr-only" htmlFor="add-model-id-input">
										Add a model ID
									</label>
									<input
										id="add-model-id-input"
										className={bare}
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
									/>
									<button type="button" aria-label="Add" className="hover:bg-muted rounded p-1" onClick={addModel}>
										<Plus className="size-3.5" strokeWidth={2} />
									</button>
								</div>
								<div>
									<div className={label}>Tags</div>
									<Tags tags={f.tags} onAdd={(name) => set({ tags: [...f.tags, { name }] })} onDelete={(name) => set({ tags: f.tags.filter((t) => t.name !== name) })} />
								</div>
							</>
						)}

						<div className="flex items-center justify-between pt-1">
							<div>
								{edit && (
									<Button type="button" variant="ghost" size="sm" onClick={() => setConfirmDelete(true)}>
										Delete
									</Button>
								)}
							</div>
							<Button type="submit" size="sm" disabled={loading}>
								Save
								{loading && <Spinner className="size-3.5" />}
							</Button>
						</div>
					</form>
				</DialogContent>
			</Dialog>
		</>
	);
}
