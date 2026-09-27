import { RefreshCw } from 'lucide-react';
import saveAs from 'file-saver';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AccessButton } from '@/components/common/AccessButton';
import { AccessControlModal } from '@/components/common/AccessControlModal';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { SensitiveInput } from '@/components/common/SensitiveInput';
import { Spinner } from '@/components/common/Spinner';
import { Tip } from '@/components/common/Tip';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { getToolServerData } from '@/lib/apis';
import { initiateOAuthRedirect, registerOAuthClient, verifyToolServerConnection } from '@/lib/apis/configs';
import { useAuthStore } from '@/lib/stores/authStore';
import { parseHeaders } from './connectionModel';
import {
	type ToolServerConnection,
	type ToolServerFields,
	blankToolServerFields,
	buildToolServer,
	exportToolServer,
	importToolServer,
	isOAuth21,
	registrationPayload,
	registrationProblem,
	specRequestUrl,
	toolServerFields,
	validateToolServer,
	verifyPayload,
	verifyProblem
} from './toolServerModel';

const bare = 'w-full bg-transparent text-sm outline-hidden placeholder:text-muted-foreground/50';
const select = 'bg-transparent pr-5 text-sm outline-hidden [&>option]:bg-popover';
const label = 'text-muted-foreground text-xs';
const linkButton = 'text-xs underline text-muted-foreground hover:text-foreground transition disabled:opacity-50 disabled:no-underline';

/**
 * Ports components/AddToolServerModal.svelte: add or edit an external tool
 * server, OpenAPI or MCP (Streamable HTTP). It verifies on request, registers
 * and authorizes OAuth 2.1 clients for MCP, imports and exports a connection as
 * JSON, and hands the finished connection to `onSubmit`. The rules live in
 * toolServerModel.ts.
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
	const fileInput = useRef<HTMLInputElement>(null);
	const [f, setF] = useState<ToolServerFields>(blankToolServerFields());
	const [showAdvanced, setShowAdvanced] = useState(false);
	const [showAccess, setShowAccess] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [loading, setLoading] = useState(false);
	const set = (patch: Partial<ToolServerFields>) => setF((prev) => ({ ...prev, ...patch }));
	const oauth = isOAuth21(f.authType);

	useEffect(() => {
		if (!open) return;
		setF(toolServerFields(connection));
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
		const problem = verifyProblem(f);
		if (problem) return void toast.error(problem);
		const headers = headersOrToast();
		if (!headers.ok) return;
		if (direct) {
			const res = await getToolServerData(f.authType === 'bearer' ? f.key : token, specRequestUrl(f.url, f.path)).catch(() => {
				toast.error('Connection failed');
				return null;
			});
			if (res) toast.success('Connection successful');
			return;
		}
		const res = await verifyToolServerConnection(token, verifyPayload(f, headers.value)).catch(() => {
			toast.error('Connection failed');
			return null;
		});
		if (res) toast.success(oauth ? 'OAuth discovery successful' : 'Connection successful');
	};

	const register = async () => {
		const problem = registrationProblem(f);
		if (problem) return void toast.error(problem);
		const res = await registerOAuthClient(token, registrationPayload(f), 'mcp').catch(() => {
			toast.error('Registration failed');
			return null;
		});
		if (res) {
			toast.warning('Please save the connection to persist the OAuth client information and do not change the ID');
			toast.success('Registration successful');
			set({ oauthClientInfo: res?.oauth_client_info ?? null });
		}
	};

	const authorize = () => {
		if (!f.id) return void toast.error('Please enter a valid ID');
		if (!edit) return void toast.error('Please save the connection before authorizing OAuth');
		initiateOAuthRedirect({ id: `server:mcp:${f.id}`, serverId: f.id, authType: 'mcp' });
	};

	const exportFile = () => {
		const headers = headersOrToast();
		if (!headers.ok) return;
		saveAs(new Blob([JSON.stringify(exportToolServer(f, headers.value))], { type: 'application/json' }), `tool-server-${f.id || f.name || 'export'}.json`);
	};

	const importFile = async (file: File | undefined) => {
		if (!file) return;
		try {
			setF(importToolServer(await file.text(), f));
			toast.success('Import successful');
		} catch {
			toast.error('Please select a valid JSON file');
		}
	};

	const submit = async () => {
		const checked = validateToolServer(f);
		if ('error' in checked) return void toast.error(checked.error);
		setF(checked.fields);
		setLoading(true);
		try {
			await onSubmit(buildToolServer(checked.fields, checked.headers));
		} finally {
			setLoading(false);
		}
		onOpenChange(false);
	};

	const verifyLabel = oauth ? 'Check OAuth Discovery' : 'Verify Connection';

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

			<AccessControlModal open={showAccess} onOpenChange={setShowAccess} accessGrants={f.accessGrants} onChange={(accessGrants) => set({ accessGrants })} />

			<Dialog open={open} onOpenChange={onOpenChange}>
				<DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
					<DialogHeader>
						<div className="flex items-center justify-between gap-3 pr-6">
							<DialogTitle className="text-sm font-medium">{edit ? 'Edit Connection' : 'Add Connection'}</DialogTitle>
							<div className="flex gap-1.5 text-xs">
								<button type="button" className="hover:underline" onClick={() => fileInput.current?.click()}>
									Import
								</button>
								<button type="button" className="hover:underline" onClick={exportFile}>
									Export
								</button>
							</div>
						</div>
						<DialogDescription className="sr-only">An external OpenAPI or MCP tool server.</DialogDescription>
					</DialogHeader>
					<input
						ref={fileInput}
						type="file"
						hidden
						accept=".json"
						aria-label="Import connection file"
						onChange={(e) => {
							importFile(e.target.files?.[0]);
							e.target.value = '';
						}}
					/>
					<form
						className="flex flex-col gap-2.5"
						onSubmit={(e) => {
							e.preventDefault();
							submit();
						}}
					>
						<div className="flex items-center justify-between">
							<div className={label}>Type</div>
							{direct ? (
								<div className="text-xs">OpenAPI</div>
							) : (
								<button type="button" aria-label="Type" className="text-xs underline-offset-2 hover:underline" onClick={() => set({ type: f.type === 'mcp' ? 'openapi' : 'mcp' })}>
									{f.type === 'mcp' ? (
										<>
											MCP <span className="text-muted-foreground">Streamable HTTP</span>
										</>
									) : (
										'OpenAPI'
									)}
								</button>
							)}
						</div>

						<div className="flex gap-2">
							<div className="min-w-0 flex-1">
								<label className={label} htmlFor="tool-server-name">
									Name
								</label>
								<input id="tool-server-name" className={bare} type="text" value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="Enter name" autoComplete="off" />
							</div>
							{!direct && (
								<div className="min-w-0 flex-1">
									<label className={label} htmlFor="tool-server-id">
										ID {f.type !== 'mcp' && <span className="opacity-50">(optional)</span>}
									</label>
									<input id="tool-server-id" className={`${bare} font-mono`} type="text" value={f.id} onChange={(e) => set({ id: e.target.value })} placeholder="auto" autoComplete="off" required={f.type === 'mcp'} />
								</div>
							)}
						</div>

						<div>
							<label className={label} htmlFor="tool-server-description">
								Description
							</label>
							<input id="tool-server-description" className={bare} type="text" value={f.description} onChange={(e) => set({ description: e.target.value })} placeholder="Enter description" autoComplete="off" />
						</div>

						<div className="flex items-end gap-2">
							<div className="min-w-0 flex-1">
								<label className={label} htmlFor="tool-server-url">
									URL
								</label>
								<input id="tool-server-url" className={bare} type="text" value={f.url} onChange={(e) => set({ url: e.target.value })} placeholder="API Base URL" autoComplete="off" required />
							</div>
							<Tip content={verifyLabel}>
								<button type="button" aria-label={verifyLabel} className="hover:bg-muted mb-0.5 rounded p-1 transition" onClick={verify}>
									<RefreshCw className="size-4" />
								</button>
							</Tip>
							<Tip content={f.enable ? 'Enabled' : 'Disabled'}>
								<span className="mb-0.5 flex items-center">
									<Switch aria-label="Enabled" checked={f.enable} onCheckedChange={(enable) => set({ enable })} />
								</span>
							</Tip>
						</div>

						<div>
							<div className="flex items-center justify-between">
								<label className={label} htmlFor="tool-server-auth">
									Auth
								</label>
								{oauth && (
									<div className="flex items-center gap-2">
										{Boolean(f.oauthClientInfo) && (
											<Tip content={edit ? 'Authorize OAuth' : 'Please save the connection before authorizing OAuth'}>
												<button type="button" className={linkButton} disabled={!edit} onClick={authorize}>
													Authorize OAuth
												</button>
											</Tip>
										)}
										<Tip content={f.oauthClientInfo ? 'Register Again' : 'Register Client'}>
											<button type="button" className={linkButton} onClick={register}>
												Register Client
											</button>
										</Tip>
										{f.oauthClientInfo ? (
											<span className="rounded-md bg-green-500/20 px-1.5 text-xs text-green-700 dark:text-green-200">Registered</span>
										) : (
											<span className="rounded-md bg-yellow-500/20 px-1.5 text-xs text-yellow-700 dark:text-yellow-200">Not Registered</span>
										)}
									</div>
								)}
							</div>
							<div className="flex gap-2">
								<select id="tool-server-auth" className={`${select} self-start`} value={f.authType} onChange={(e) => set({ authType: e.target.value })}>
									<option value="none">None</option>
									<option value="bearer">Bearer</option>
									<option value="session">Session</option>
									{!direct && (
										<>
											<option value="system_oauth">OAuth</option>
											{f.type === 'mcp' && (
												<>
													<option value="oauth_2.1">OAuth 2.1</option>
													<option value="oauth_2.1_static">OAuth 2.1 (Static)</option>
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
									) : f.authType === 'oauth_2.1' ? (
										<div className="text-muted-foreground text-xs">Uses OAuth 2.1 Dynamic Client Registration</div>
									) : f.authType === 'oauth_2.1_static' ? (
										<div className="flex flex-col gap-1.5">
											<SensitiveInput value={f.oauthClientId} onChange={(oauthClientId) => set({ oauthClientId })} placeholder="Client ID" required={false} />
											<SensitiveInput value={f.oauthClientSecret} onChange={(oauthClientSecret) => set({ oauthClientSecret })} placeholder="Client Secret" required={false} />
											<input className={bare} type="text" aria-label="OAuth Server URL" value={f.oauthServerUrl} onChange={(e) => set({ oauthServerUrl: e.target.value })} placeholder="OAuth Server URL" autoComplete="off" />
										</div>
									) : null}
								</div>
							</div>
						</div>

						<div className="flex items-center justify-between">
							<button type="button" className="text-muted-foreground hover:text-foreground w-fit text-xs" aria-expanded={showAdvanced} onClick={() => setShowAdvanced((v) => !v)}>
								{showAdvanced ? '▾' : '▸'} Advanced
							</button>
							{!direct && <AccessButton label="Access Control" onClick={() => setShowAccess(true)} />}
						</div>

						{showAdvanced && (
							<>
								{f.type === 'openapi' && (
									<div>
										<div className={label}>OpenAPI Spec</div>
										<div className="flex gap-2">
											<select aria-label="OpenAPI Spec source" className={`${select} self-start`} value={f.specType} onChange={(e) => set({ specType: e.target.value as 'url' | 'json' })}>
												<option value="url">URL</option>
												<option value="json">JSON</option>
											</select>
											{f.specType === 'url' ? (
												<input className={bare} type="text" aria-label="openapi.json URL or Path" value={f.path} onChange={(e) => set({ path: e.target.value })} placeholder="openapi.json URL or Path" autoComplete="off" required />
											) : (
												<textarea className={`${bare} resize-y`} aria-label="JSON Spec" rows={5} value={f.spec} onChange={(e) => set({ spec: e.target.value })} placeholder="JSON Spec" required />
											)}
										</div>
										{f.specType === 'url' && <div className="text-muted-foreground mt-1 text-xs">WebUI will make requests to "{specRequestUrl(f.url, f.path)}"</div>}
									</div>
								)}

								{f.type === 'mcp' && oauth && (
									<>
										<div>
											<label className={label} htmlFor="oauth-scope">
												OAuth Scopes
											</label>
											<input id="oauth-scope" className={bare} type="text" value={f.oauthScope} onChange={(e) => set({ oauthScope: e.target.value })} placeholder="Use discovered scopes" autoComplete="off" />
										</div>
										<div>
											<label className={label} htmlFor="oauth-resource-parameter">
												OAuth Resource Parameter
											</label>
											<select id="oauth-resource-parameter" className={`${select} block`} value={f.oauthResourceParameter} onChange={(e) => set({ oauthResourceParameter: e.target.value })}>
												<option value="auto">Automatic</option>
												<option value="include">Include</option>
												<option value="omit">Omit</option>
											</select>
										</div>
									</>
								)}

								{!direct && (
									<div>
										<label className={label} htmlFor="tool-server-headers">
											Headers
										</label>
										<Tip content='Enter additional headers in JSON format (e.g. {"X-Custom-Header": "value"}'>
											<textarea id="tool-server-headers" className={`${bare} min-h-8 resize-y`} value={f.headers} onChange={(e) => set({ headers: e.target.value })} placeholder="Enter additional headers in JSON format" />
										</Tip>
									</div>
								)}
							</>
						)}

						{!direct && (
							<div className="border-t pt-2.5">
								<label className={label} htmlFor="function-name-filter-list">
									Function Name Filter List
								</label>
								<input
									id="function-name-filter-list"
									className={bare}
									type="text"
									value={f.functionNameFilterList}
									onChange={(e) => set({ functionNameFilterList: e.target.value })}
									placeholder="Enter function name filter list (e.g. func1, !func2)"
									autoComplete="off"
								/>
							</div>
						)}

						{f.type === 'mcp' && (
							<div className="rounded-2xl bg-yellow-500/20 px-4 py-3 text-xs text-yellow-700 dark:text-yellow-200">
								{/* LICENSE covers this Open WebUI wordmark. Do not alter, remove, obscure, or replace it
								    except as LICENSE permits: https://docs.openwebui.com/license. */}
								Warning: MCP support is experimental and its specification changes often, which can lead to incompatibilities. OpenAPI specification support is directly maintained by the Open WebUI team,
								making it the more reliable option for compatibility.{' '}
								<a className="underline" href="https://docs.openwebui.com/" target="_blank" rel="noreferrer">
									Read more →
								</a>
							</div>
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
