import saveAs from 'file-saver';
import { useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AccessButton } from '@/components/common/AccessButton';
import { AccessControlModal } from '@/components/common/AccessControlModal';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { Spinner } from '@/components/common/Spinner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FieldMessage } from '@/components/ui/field-message';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Textarea } from '@/components/ui/textarea';
import { getToolServerData } from '@/lib/apis';
import { initiateOAuthRedirect, registerOAuthClient, verifyToolServerConnection } from '@/lib/apis/configs';
import { useAuthStore } from '@/lib/stores/authStore';
import { parseHeaders, type TestResult } from './connectionModel';
import {
	ConnectionUrlField,
	Disclosure,
	FieldLabel,
	FormField,
	SecretInput,
	SelectField,
	SwitchField
} from './formFields';
import {
	blankToolServerFields,
	buildToolServer,
	directVerifyToken,
	exportToolServer,
	HEADERS_JSON,
	importToolServer,
	isOAuth21,
	registrationPayload,
	registrationProblem,
	specRequestUrl,
	type ToolServerConnection,
	type ToolServerField,
	type ToolServerFields,
	toolServerFields,
	validateToolServer,
	verifyPayload,
	verifyProblem
} from './toolServerModel';

const AUTH_HELP: Record<string, string> = {
	none: 'Requests go without credentials.',
	session: "Sends the signed-in user's session credentials.",
	system_oauth: "Sends the signed-in user's OAuth access token.",
	'oauth_2.1': 'Registers a client by OAuth 2.1 Dynamic Client Registration.',
	'oauth_2.1_static': 'Uses the OAuth 2.1 client you give below.'
};

const RESOURCE_PARAMETER = [
	['auto', 'Automatic'],
	['include', 'Include'],
	['omit', 'Omit']
] as const;

type Errors = Partial<Record<ToolServerField, string>>;

/** A thrown error's words, or a plain sentence when it has none. */
const causeText = (error: unknown) =>
	typeof error === 'string' && error ? error : "Couldn't reach the server. Check the URL and that it is running.";

/**
 * Ports components/AddToolServerModal.svelte: add or edit an external tool
 * server, OpenAPI or MCP (Streamable HTTP). It tests the connection on
 * request, registers and authorizes OAuth 2.1 clients for MCP, imports and
 * exports a connection as JSON, and hands the finished connection to
 * `onSubmit`. The rules live in toolServerModel.ts.
 *
 * #933: the connection dialogs' one form language (see AddConnectionModal):
 * labelled shared fields, the server type as a segmented control, Advanced
 * behind a chevron disclosure, problems said under their fields. #1018: Test
 * connection beside the URL, its result under it.
 *
 * Differences from the original: every open starts from `connection` (or
 * blank); an export no longer contains the API key; an import no longer brings
 * access grants in.
 */
export function AddToolServerModal({
	open,
	onOpenChange,
	edit = false,
	direct = false,
	connection = null,
	onSubmit,
	onDelete
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	edit?: boolean;
	direct?: boolean;
	connection?: ToolServerConnection | null;
	onSubmit: (connection: ToolServerConnection) => void | Promise<void>;
	onDelete?: () => void | Promise<void>;
}) {
	const token = useAuthStore((s) => s.token) ?? '';
	const ids = useId();
	const id = (name: string) => `${ids}-${name}`;
	const fileInput = useRef<HTMLInputElement>(null);
	const [f, setF] = useState<ToolServerFields>(blankToolServerFields());
	const [showAdvanced, setShowAdvanced] = useState(false);
	const [showAccess, setShowAccess] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [errors, setErrors] = useState<Errors>({});
	const [registration, setRegistration] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const oauth = isOAuth21(f.authType);
	const fieldOf: Partial<Record<keyof ToolServerFields, ToolServerField>> = {
		url: 'url',
		id: 'id',
		authType: 'auth',
		oauthClientInfo: 'auth',
		path: 'path',
		spec: 'spec',
		specType: 'spec',
		headers: 'headers',
		type: 'id'
	};
	const set = (patch: Partial<ToolServerFields>) => {
		setF((prev) => ({ ...prev, ...patch }));
		// An edit to a field clears what was said about it.
		setErrors((prev) => {
			const next = { ...prev };
			for (const key of Object.keys(patch)) {
				const field = fieldOf[key as keyof ToolServerFields];
				if (field) delete next[field];
			}
			return next;
		});
	};

	useEffect(() => {
		if (!open) return;
		setF(toolServerFields(connection));
		setShowAdvanced(false);
		setErrors({});
		setRegistration(null);
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
			setErrors((prev) => ({ ...prev, headers: HEADERS_JSON }));
			return { ok: false as const, value: null };
		}
	};

	const test = async (): Promise<TestResult | null> => {
		const problem = verifyProblem(f);
		if (problem) return { ok: false, text: problem };
		const headers = checkedHeaders();
		if (!headers.ok) return null;
		try {
			if (direct) {
				await getToolServerData(directVerifyToken(f, token), specRequestUrl(f.url, f.path));
				return { ok: true, text: 'Reachable: the spec loaded' };
			}
			await verifyToolServerConnection(token, verifyPayload(f, headers.value));
			return { ok: true, text: oauth ? 'Reachable: OAuth discovery succeeded' : 'Reachable' };
		} catch (error) {
			return { ok: false, text: causeText(error) };
		}
	};

	const register = async () => {
		const problem = registrationProblem(f);
		if (problem) return void setRegistration(problem);
		setRegistration(null);
		try {
			const res = await registerOAuthClient(token, registrationPayload(f), 'mcp');
			if (!res) throw new Error();
			set({ oauthClientInfo: res?.oauth_client_info ?? null });
			toast.success('Client registered. Save the connection to keep it, and keep the ID as it is.');
		} catch (error) {
			setRegistration(`Couldn't register the client. ${causeText(error)}`);
		}
	};

	const authorize = () => {
		if (!f.id) return void setRegistration('Enter an ID first. Authorizing needs one.');
		initiateOAuthRedirect({ id: `server:mcp:${f.id}`, serverId: f.id, authType: 'mcp' });
	};

	const exportFile = () => {
		const headers = checkedHeaders();
		if (!headers.ok) return;
		saveAs(
			new Blob([JSON.stringify(exportToolServer(f, headers.value))], { type: 'application/json' }),
			`tool-server-${f.id || f.name || 'export'}.json`
		);
	};

	const importFile = async (file: File | undefined) => {
		if (!file) return;
		try {
			setF(importToolServer(await file.text(), f));
			setErrors({});
			toast.success(`Imported “${file.name}”`);
		} catch {
			toast.error(`Couldn't import “${file.name}”. It isn't a tool server file.`);
		}
	};

	const submit = async () => {
		const checked = validateToolServer(f);
		if ('error' in checked) {
			if (checked.field === 'headers' || checked.field === 'path' || checked.field === 'spec') setShowAdvanced(true);
			setErrors({ [checked.field]: checked.error });
			// After the render that shows it (and opens Advanced), so the field exists.
			setTimeout(() => document.getElementById(id(checked.field))?.focus());
			return;
		}
		setF(checked.fields);
		setLoading(true);
		try {
			await onSubmit(buildToolServer(checked.fields, checked.headers));
		} finally {
			setLoading(false);
		}
		onOpenChange(false);
	};

	const authOptions: [string, string][] = [
		['none', 'None'],
		['bearer', 'API key (Bearer)'],
		['session', 'Session'],
		...(direct
			? []
			: ([
					['system_oauth', 'OAuth'],
					...(f.type === 'mcp'
						? [
								['oauth_2.1', 'OAuth 2.1'],
								['oauth_2.1_static', 'OAuth 2.1 (static client)']
							]
						: [])
				] as [string, string][]))
	];

	return (
		<>
			<ConfirmDialog
				open={confirmDelete}
				onOpenChange={setConfirmDelete}
				title={`Delete “${f.name || f.url || 'this tool server'}”?`}
				confirmLabel="Delete connection"
				destructive
				onConfirm={async () => {
					setConfirmDelete(false);
					await onDelete?.();
					onOpenChange(false);
				}}
			>
				Its tools stop being offered in chats. This can't be undone.
			</ConfirmDialog>

			<AccessControlModal
				open={showAccess}
				onOpenChange={setShowAccess}
				accessGrants={f.accessGrants}
				onChange={(accessGrants) => set({ accessGrants })}
			/>

			<Dialog open={open} onOpenChange={onOpenChange}>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>{edit ? 'Edit tool server' : 'Add tool server'}</DialogTitle>
						<DialogDescription>
							{direct
								? 'An OpenAPI tool server your browser talks to directly.'
								: 'An OpenAPI or MCP server whose tools chats can use.'}
						</DialogDescription>
						<div className="flex gap-1">
							<Button variant="outline" size="sm" type="button" onClick={() => fileInput.current?.click()}>
								Import
							</Button>
							<Button variant="outline" size="sm" type="button" onClick={exportFile}>
								Export
							</Button>
						</div>
					</DialogHeader>
					<input
						ref={fileInput}
						type="file"
						hidden
						accept=".json"
						aria-label="Import connection file"
						onChange={(e) => {
							void importFile(e.target.files?.[0]);
							e.target.value = '';
						}}
					/>
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
									<span id={id('type-label')}>Server type</span>
								</FieldLabel>
								<SegmentedControl
									aria-labelledby={id('type-label')}
									value={f.type === 'mcp' ? 'mcp' : 'openapi'}
									onValueChange={(type) => set({ type })}
									options={[
										{ value: 'openapi', label: 'OpenAPI' },
										{ value: 'mcp', label: 'MCP (Streamable HTTP)' }
									]}
									className="self-start"
								/>
								{f.type === 'mcp' && (
									<FieldMessage
										id={id('type-help')}
										className="mt-1.5"
										help="MCP support is experimental and its specification changes often, so a server may stop working after an update. OpenAPI is the steadier choice."
									/>
								)}
							</div>
						)}

						<div className="grid gap-4 sm:grid-cols-2">
							<FormField id={id('name')} label="Name" optional>
								{(props) => (
									<Input {...props} value={f.name} onChange={(e) => set({ name: e.target.value })} autoComplete="off" />
								)}
							</FormField>
							{!direct && (
								<FormField
									id={id('id')}
									label="ID"
									optional={f.type !== 'mcp'}
									help={f.type === 'mcp' ? undefined : 'Empty: one is made for it.'}
									error={errors.id}
								>
									{(props) => (
										<Input
											{...props}
											className="font-mono"
											value={f.id}
											onChange={(e) => set({ id: e.target.value })}
											autoComplete="off"
										/>
									)}
								</FormField>
							)}
						</div>

						<FormField id={id('description')} label="Description" optional>
							{(props) => (
								<Input
									{...props}
									value={f.description}
									onChange={(e) => set({ description: e.target.value })}
									autoComplete="off"
								/>
							)}
						</FormField>

						<ConnectionUrlField
							id={id('url')}
							value={f.url}
							onChange={(url) => set({ url })}
							placeholder="https://tools.example.com"
							error={errors.url}
							testLabel={oauth ? 'Check OAuth discovery' : 'Test connection'}
							onTest={test}
						/>

						<SwitchField
							id={id('enable')}
							label="Enabled"
							checked={f.enable}
							onCheckedChange={(enable) => set({ enable })}
						/>

						<FormField id={id('auth')} label="Authentication" help={AUTH_HELP[f.authType]} error={errors.auth}>
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
							<FormField id={id('key')} label="API key" optional>
								{(props) => <SecretInput {...props} value={f.key} onChange={(key) => set({ key })} />}
							</FormField>
						)}
						{f.authType === 'oauth_2.1_static' && (
							<>
								<FormField id={id('client-id')} label="Client ID">
									{(props) => (
										<SecretInput
											{...props}
											value={f.oauthClientId}
											onChange={(oauthClientId) => set({ oauthClientId })}
										/>
									)}
								</FormField>
								<FormField id={id('client-secret')} label="Client secret">
									{(props) => (
										<SecretInput
											{...props}
											value={f.oauthClientSecret}
											onChange={(oauthClientSecret) => set({ oauthClientSecret })}
										/>
									)}
								</FormField>
								<FormField id={id('oauth-server')} label="OAuth server URL" optional>
									{(props) => (
										<Input
											{...props}
											type="url"
											value={f.oauthServerUrl}
											onChange={(e) => set({ oauthServerUrl: e.target.value })}
											autoComplete="off"
										/>
									)}
								</FormField>
							</>
						)}
						{oauth && (
							<div className="flex flex-col gap-1.5">
								<div className="flex flex-wrap items-center gap-2">
									<Badge variant={f.oauthClientInfo ? 'success' : 'warning'}>
										{f.oauthClientInfo ? 'Registered' : 'Not registered'}
									</Badge>
									<Button variant="outline" size="sm" type="button" onClick={register}>
										{f.oauthClientInfo ? 'Register again' : 'Register client'}
									</Button>
									{Boolean(f.oauthClientInfo) && (
										<Button variant="outline" size="sm" type="button" disabled={!edit} onClick={authorize}>
											Authorize
										</Button>
									)}
								</div>
								<FieldMessage
									id={id('registration')}
									error={registration}
									help={f.oauthClientInfo && !edit ? 'Save the connection first, then authorize it.' : undefined}
								/>
							</div>
						)}

						<Disclosure title="Advanced" open={showAdvanced} onOpenChange={setShowAdvanced}>
							<div className="flex flex-col gap-4">
								{f.type === 'openapi' && (
									<div className="flex flex-col gap-4">
										<div className="flex flex-col">
											<FieldLabel>
												<span id={id('spec-label')}>OpenAPI spec</span>
											</FieldLabel>
											<SegmentedControl
												aria-labelledby={id('spec-label')}
												value={f.specType}
												onValueChange={(specType) => set({ specType })}
												options={[
													{ value: 'url', label: 'From a URL' },
													{ value: 'json', label: 'JSON' }
												]}
												className="self-start"
											/>
										</div>
										{f.specType === 'url' ? (
											<FormField
												id={id('path')}
												label="Spec path or URL"
												// An OpenAPI server's URL is saved without its trailing slash.
												help={`local-llm sends requests to ${specRequestUrl(f.url.trim().replace(/\/$/, ''), f.path)}`}
												error={errors.path}
											>
												{(props) => (
													<Input
														{...props}
														value={f.path}
														onChange={(e) => set({ path: e.target.value })}
														autoComplete="off"
													/>
												)}
											</FormField>
										) : (
											<FormField id={id('spec')} label="Spec" error={errors.spec}>
												{(props) => (
													<Textarea
														{...props}
														className="font-mono"
														rows={5}
														value={f.spec}
														onChange={(e) => set({ spec: e.target.value })}
													/>
												)}
											</FormField>
										)}
									</div>
								)}

								{f.type === 'mcp' && oauth && (
									<>
										<FormField
											id={id('scope')}
											label="OAuth scopes"
											optional
											help="Empty: the scopes the server advertises."
										>
											{(props) => (
												<Input
													{...props}
													value={f.oauthScope}
													onChange={(e) => set({ oauthScope: e.target.value })}
													autoComplete="off"
												/>
											)}
										</FormField>
										<FormField id={id('resource')} label="OAuth resource parameter">
											{(props) => (
												<SelectField
													{...props}
													className="sm:w-60"
													value={f.oauthResourceParameter}
													onChange={(oauthResourceParameter) => set({ oauthResourceParameter })}
													options={RESOURCE_PARAMETER}
												/>
											)}
										</FormField>
									</>
								)}

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

								{!direct && (
									<FormField
										id={id('filter')}
										label="Function name filter"
										optional
										help="Which of its functions chats may call, separated by commas: func1 allows one, !func2 leaves one out."
									>
										{(props) => (
											<Input
												{...props}
												value={f.functionNameFilterList}
												onChange={(e) => set({ functionNameFilterList: e.target.value })}
												autoComplete="off"
											/>
										)}
									</FormField>
								)}
							</div>
						</Disclosure>

						<div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
							<div className="flex flex-wrap gap-2">
								{edit && (
									<Button type="button" variant="destructive" onClick={() => setConfirmDelete(true)}>
										Delete connection
									</Button>
								)}
								{!direct && <AccessButton label="Access control" onClick={() => setShowAccess(true)} />}
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
