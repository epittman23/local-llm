import { RefreshCw, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { AccessButton } from '@/components/common/AccessButton';
import { AccessControlModal } from '@/components/common/AccessControlModal';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { SensitiveInput } from '@/components/common/SensitiveInput';
import { Spinner } from '@/components/common/Spinner';
import { Tip } from '@/components/common/Tip';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
	getOrchestratorLifecycle,
	getOrchestratorPolicy,
	putOrchestratorLifecycle,
	putOrchestratorPolicy,
	refreshOrchestratorTerminals,
	verifyTerminalServerConnection
} from '@/lib/apis/configs';
import { getTerminalConfig } from '@/lib/apis/terminal';
import { useAuthStore } from '@/lib/stores/authStore';
import { specRequestUrl } from './toolServerModel';
import {
	type PolicyFields,
	type TerminalConnection,
	type TerminalFields,
	blankPolicy,
	buildPolicyData,
	buildTerminalConnection,
	parseLifecycle,
	policyFromServer,
	suggestPolicyId,
	terminalFields
} from './terminalServerModel';

const bare = 'w-full bg-transparent text-sm outline-hidden placeholder:text-muted-foreground/50';
const mono = `${bare} font-mono`;
const select = 'bg-transparent pr-5 text-sm outline-hidden [&>option]:bg-popover';
const label = 'text-muted-foreground text-xs';

/**
 * Ports components/AddTerminalServerModal.svelte: add or edit an Open Terminal
 * connection. Verify asks the backend what the URL is (a plain terminal or an
 * Orchestrator); for an Orchestrator the admin can edit its provisioning policy
 * and lifecycle, which Save writes to the Orchestrator *before* handing the
 * connection to `onSubmit`, and can ask it to refresh running terminals.
 * With `direct` (Phase 10's personal terminals) there is no ID, access control
 * or policy, and verification happens from the browser. Rules in
 * terminalServerModel.ts.
 */
export function AddTerminalServerModal({
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
	connection?: TerminalConnection | null;
	onSubmit: (connection: TerminalConnection) => void | Promise<void>;
	onDelete?: () => void | Promise<void>;
}) {
	const token = useAuthStore((s) => s.token) ?? '';
	const [f, setF] = useState<TerminalFields>(terminalFields(null));
	const [p, setP] = useState<PolicyFields>(blankPolicy());
	const [showAdvanced, setShowAdvanced] = useState(false);
	const [showOrchestrator, setShowOrchestrator] = useState(false);
	const [showAccess, setShowAccess] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [verifying, setVerifying] = useState(false);
	const [refreshing, setRefreshing] = useState(false);
	const [saving, setSaving] = useState(false);
	const [loadingPolicy, setLoadingPolicy] = useState(false);
	const [policyError, setPolicyError] = useState('');
	const [refreshOnlyIdle, setRefreshOnlyIdle] = useState(true);
	const [refreshReset, setRefreshReset] = useState(false);
	const set = (patch: Partial<TerminalFields>) => setF((prev) => ({ ...prev, ...patch }));
	const setPolicy = (patch: Partial<PolicyFields>) => setP((prev) => ({ ...prev, ...patch }));
	const orchestrator = f.serverType === 'orchestrator' && !direct;

	useEffect(() => {
		if (!open) return;
		const start = terminalFields(connection);
		setF(start);
		setP(blankPolicy());
		setShowAdvanced(false);
		setShowOrchestrator(false);
		setRefreshOnlyIdle(true);
		setRefreshReset(false);
		setPolicyError('');
		setSaving(false);
		// An existing Orchestrator connection: read its policy and lifecycle back,
		// so Save does not overwrite them with the blank defaults.
		if (!connection || start.serverType !== 'orchestrator' || !start.policyId || direct) return;
		let cancelled = false;
		setLoadingPolicy(true);
		(async () => {
			try {
				const policy = await getOrchestratorPolicy(token, start.url, start.key, start.policyId, start.authType).catch((error: any) => {
					if (error?.status !== 404) throw error;
					return null;
				});
				const lifecycle = await getOrchestratorLifecycle(token, start.url, start.key, start.policyId, start.authType);
				if (!cancelled) setP(policyFromServer(policy?.data, lifecycle?.data));
			} catch (error: any) {
				if (!cancelled) setPolicyError(error?.message || String(error));
			} finally {
				if (!cancelled) setLoadingPolicy(false);
			}
		})();
		return () => {
			cancelled = true;
		};
		// Seeded when the dialog opens; edits inside it are local.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	const verify = async () => {
		const url = f.url.replace(/\/$/, '');
		if (!url) return void toast.error('Please enter a valid URL');
		setVerifying(true);
		try {
			if (direct) {
				const res = await getTerminalConfig(url, f.key);
				if (res) toast.success('Server connection verified');
				else toast.error('Server connection failed');
				return;
			}
			// A system connection is checked by the backend: no CORS, and the key stays server-side.
			const result = await verifyTerminalServerConnection(token, { url, key: f.key, auth_type: f.authType });
			const type = result?.type ?? null;
			if (type) {
				set({ serverType: type, ...(type === 'orchestrator' && !f.policyId ? { policyId: suggestPolicyId(f.id, f.name) } : {}) });
				toast.success(`Connected (${type === 'orchestrator' ? 'Orchestrator' : 'Terminal'})`);
			} else {
				set({ serverType: null });
				toast.error('Server connection failed');
			}
		} catch {
			set({ serverType: null });
			toast.error('Server connection failed');
		} finally {
			setVerifying(false);
		}
	};

	const refreshTerminals = async () => {
		if (!f.policyId) return void toast.error('Policy ID is required');
		setRefreshing(true);
		try {
			const result = await refreshOrchestratorTerminals(token, f.url, f.key, { policy_id: f.policyId, only_idle: refreshOnlyIdle, reset: refreshReset }, f.authType);
			toast.success(`Refresh requested: ${(result as { refreshed?: number } | null)?.refreshed ?? 0} terminal(s)`);
		} catch (err) {
			toast.error(`Failed to refresh terminals: ${err}`);
		} finally {
			setRefreshing(false);
		}
	};

	const submit = async () => {
		if (!f.url) return void toast.error('Please enter a valid URL');
		if (loadingPolicy) return void toast.error('Policy is still loading');
		if (policyError) return void toast.error(`Failed to load policy: ${policyError}`);
		const result = buildTerminalConnection(f, connection?.config, { direct });
		setSaving(true);
		try {
			if (orchestrator && f.policyId) {
				const lifecycle = parseLifecycle(p.lifecycleJson);
				if ('error' in lifecycle) return void toast.error(lifecycle.error);
				try {
					await putOrchestratorPolicy(token, result.url ?? '', result.key ?? '', f.policyId, buildPolicyData(p), f.authType);
					await putOrchestratorLifecycle(token, result.url ?? '', result.key ?? '', f.policyId, lifecycle.value, f.authType);
				} catch (err) {
					return void toast.error(`Failed to save policy: ${err}`);
				}
			}
			await onSubmit(result);
			onOpenChange(false);
		} finally {
			setSaving(false);
		}
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

			<AccessControlModal open={showAccess} onOpenChange={setShowAccess} accessGrants={f.accessGrants} onChange={(accessGrants) => set({ accessGrants })} />

			<Dialog open={open} onOpenChange={onOpenChange}>
				<DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
					<DialogHeader>
						<DialogTitle className="text-sm font-medium">{edit ? 'Edit Terminal Connection' : 'Add Terminal Connection'}</DialogTitle>
						<DialogDescription className="sr-only">An Open Terminal instance or Orchestrator.</DialogDescription>
					</DialogHeader>
					<form
						className="flex flex-col gap-2.5"
						onSubmit={(e) => {
							e.preventDefault();
							submit();
						}}
					>
						<div className="flex gap-2">
							<div className="min-w-0 flex-1">
								<label className={label} htmlFor="terminal-name">
									Name
								</label>
								<input id="terminal-name" className={bare} type="text" value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="My Terminal" autoComplete="off" />
							</div>
							{!direct && (
								<div className="min-w-0 flex-1">
									<label className={label} htmlFor="terminal-id">
										ID <span className="opacity-50">(optional)</span>
									</label>
									<input id="terminal-id" className={mono} type="text" value={f.id} onChange={(e) => set({ id: e.target.value })} placeholder="auto" autoComplete="off" />
								</div>
							)}
						</div>

						<div className="flex items-end gap-2">
							<div className="min-w-0 flex-1">
								<label className={label} htmlFor="terminal-url">
									URL
								</label>
								<input id="terminal-url" className={bare} type="text" value={f.url} onChange={(e) => set({ url: e.target.value })} placeholder="http://localhost:9900" required autoComplete="off" />
							</div>
							<Tip content="Verify Connection">
								<button type="button" aria-label="Verify Connection" className="hover:bg-muted mb-0.5 rounded p-1 transition" disabled={verifying} onClick={verify}>
									{verifying ? <Spinner className="size-4" /> : <RefreshCw className="size-4" />}
								</button>
							</Tip>
						</div>

						<div>
							<label className={label} htmlFor="terminal-chat-uploads">
								Chat Uploads
							</label>
							<select id="terminal-chat-uploads" className={`${select} block`} value={f.chatUploads} onChange={(e) => set({ chatUploads: e.target.value as TerminalFields['chatUploads'] })}>
								<option value="default">Default</option>
								<option value="filesystem">Filesystem</option>
							</select>
						</div>

						{orchestrator && (
							<>
								<button type="button" className="text-muted-foreground hover:text-foreground w-fit text-xs" aria-expanded={showOrchestrator} onClick={() => setShowOrchestrator((v) => !v)}>
									{showOrchestrator ? '▾' : '▸'} Orchestrator
								</button>
								{showOrchestrator && (
									<OrchestratorFields
										f={f}
										p={p}
										set={set}
										setPolicy={setPolicy}
										policyIdLocked={edit && Boolean(connection?.policy_id)}
										loadingPolicy={loadingPolicy}
										policyError={policyError}
										refreshOnlyIdle={refreshOnlyIdle}
										setRefreshOnlyIdle={setRefreshOnlyIdle}
										refreshReset={refreshReset}
										setRefreshReset={setRefreshReset}
										refreshing={refreshing}
										onRefresh={refreshTerminals}
									/>
								)}
							</>
						)}

						<div className="flex items-center justify-between">
							<button type="button" className="text-muted-foreground hover:text-foreground w-fit text-xs" aria-expanded={showAdvanced} onClick={() => setShowAdvanced((v) => !v)}>
								{showAdvanced ? '▾' : '▸'} Advanced
							</button>
							{!direct && <AccessButton onClick={() => setShowAccess(true)} />}
						</div>

						{showAdvanced && (
							<div>
								<div className={label}>OpenAPI Spec</div>
								<input className={bare} type="text" aria-label="openapi.json URL or Path" value={f.path} onChange={(e) => set({ path: e.target.value })} placeholder="openapi.json URL or Path" autoComplete="off" required />
								<div className="text-muted-foreground mt-1 text-xs">WebUI will make requests to "{specRequestUrl(f.url, f.path)}"</div>
							</div>
						)}

						<div>
							<label className={label} htmlFor="terminal-auth">
								Auth
							</label>
							<div className="flex gap-2">
								<select id="terminal-auth" className={`${select} self-start`} value={f.authType} onChange={(e) => set({ authType: e.target.value })}>
									<option value="none">None</option>
									<option value="bearer">Bearer</option>
									{!direct && (
										<>
											<option value="session">Session</option>
											<option value="system_oauth">OAuth</option>
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
									) : null}
								</div>
							</div>
						</div>

						<div className="flex items-center justify-between pt-1">
							<div>
								{edit && (
									<Button type="button" variant="ghost" size="sm" onClick={() => setConfirmDelete(true)}>
										Delete
									</Button>
								)}
							</div>
							<Button type="submit" size="sm" disabled={saving || loadingPolicy || Boolean(policyError)}>
								Save
								{saving && <Spinner className="size-3.5" />}
							</Button>
						</div>
					</form>
				</DialogContent>
			</Dialog>
		</>
	);
}

/** The Orchestrator block: terminal contexts, the policy, and Refresh Terminals. */
function OrchestratorFields({
	f,
	p,
	set,
	setPolicy,
	policyIdLocked,
	loadingPolicy,
	policyError,
	refreshOnlyIdle,
	setRefreshOnlyIdle,
	refreshReset,
	setRefreshReset,
	refreshing,
	onRefresh
}: {
	f: TerminalFields;
	p: PolicyFields;
	set: (patch: Partial<TerminalFields>) => void;
	setPolicy: (patch: Partial<PolicyFields>) => void;
	policyIdLocked: boolean;
	loadingPolicy: boolean;
	policyError: string;
	refreshOnlyIdle: boolean;
	setRefreshOnlyIdle: (v: boolean) => void;
	refreshReset: boolean;
	setRefreshReset: (v: boolean) => void;
	refreshing: boolean;
	onRefresh: () => void;
}) {
	const setEnv = (idx: number, patch: Partial<{ key: string; value: string }>) => setPolicy({ envPairs: p.envPairs.map((pair, i) => (i === idx ? { ...pair, ...patch } : pair)) });
	return (
		<>
			<div>
				<div className={`${label} mb-1`}>Terminal Contexts</div>
				<div className="text-muted-foreground grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-xs">
					<label htmlFor="terminal-chat-context">Chat</label>
					<select id="terminal-chat-context" className={`${select} text-xs`} value={f.chatContext} onChange={(e) => set({ chatContext: e.target.value as TerminalFields['chatContext'] })}>
						<option value="default">Shared</option>
						<option value="chat_id">Per chat</option>
						<option value="off">Off</option>
					</select>
					<label htmlFor="terminal-automation-context">Automation</label>
					<select id="terminal-automation-context" className={`${select} text-xs`} value={f.automationContext} onChange={(e) => set({ automationContext: e.target.value as TerminalFields['automationContext'] })}>
						<option value="default">Shared</option>
						<option value="automation_id">Per automation</option>
						<option value="off">Off</option>
					</select>
				</div>
			</div>

			<div>
				<label className={label} htmlFor="policy-id">
					Policy ID
				</label>
				<input id="policy-id" className={mono} type="text" value={f.policyId} onChange={(e) => set({ policyId: e.target.value })} placeholder="python-ds" autoComplete="off" disabled={policyIdLocked} />
			</div>

			{loadingPolicy ? (
				<div className="text-muted-foreground text-xs">Loading policy...</div>
			) : policyError ? (
				<div className="text-destructive text-xs">Failed to load policy: {policyError}</div>
			) : null}

			<div>
				<label className={label} htmlFor="policy-image">
					Image <span className="opacity-50">(optional)</span>
				</label>
				<input id="policy-image" className={mono} type="text" value={p.image} onChange={(e) => setPolicy({ image: e.target.value })} placeholder="ghcr.io/open-webui/open-terminal:latest" autoComplete="off" />
			</div>

			<div className="flex gap-2">
				<div className="min-w-0 flex-1">
					<label className={label} htmlFor="policy-cpu">
						CPU
					</label>
					<input id="policy-cpu" className={mono} type="text" value={p.cpu} onChange={(e) => setPolicy({ cpu: e.target.value })} placeholder="1" autoComplete="off" />
				</div>
				<div className="min-w-0 flex-1">
					<label className={label} htmlFor="policy-memory">
						Memory
					</label>
					<input id="policy-memory" className={mono} type="text" value={p.memory} onChange={(e) => setPolicy({ memory: e.target.value })} placeholder="1Gi" autoComplete="off" />
				</div>
			</div>

			<div className="flex gap-2">
				<div className="min-w-0 flex-1">
					<label className={label} htmlFor="policy-storage">
						Storage
					</label>
					<div className="flex gap-2">
						<select id="policy-storage" className={`${select} self-start`} value={p.storage} onChange={(e) => setPolicy({ storage: e.target.value as PolicyFields['storage'] })}>
							<option value="ephemeral">Ephemeral</option>
							<option value="persistent">Persistent</option>
						</select>
						{p.storage === 'persistent' && (
							<input className={mono} type="text" aria-label="Storage size" value={p.storageSize} onChange={(e) => setPolicy({ storageSize: e.target.value })} placeholder="5Gi" autoComplete="off" />
						)}
					</div>
				</div>
				<div className="min-w-0 flex-1">
					<label className={label} htmlFor="idle-timeout">
						Idle Timeout <span className="opacity-50">(min)</span>
					</label>
					<input id="idle-timeout" className={mono} type="number" min={0} value={p.idleTimeout} onChange={(e) => setPolicy({ idleTimeout: e.target.value === '' ? 0 : Number(e.target.value) })} placeholder="30" autoComplete="off" />
				</div>
			</div>

			<div>
				<div className="mb-0.5 flex items-center justify-between">
					<div className={label}>Environment Variables</div>
					<button type="button" className="text-muted-foreground hover:text-foreground text-xs transition" onClick={() => setPolicy({ envPairs: [...p.envPairs, { key: '', value: '' }] })}>
						+ Add
					</button>
				</div>
				{p.envPairs.map((pair, idx) => (
					<div key={idx} className="mb-1 flex gap-1.5">
						<input className={`${mono} flex-1`} type="text" aria-label={`Variable ${idx + 1} name`} value={pair.key} onChange={(e) => setEnv(idx, { key: e.target.value })} placeholder="KEY" />
						<input className={`${mono} flex-[2]`} type="text" aria-label={`Variable ${idx + 1} value`} value={pair.value} onChange={(e) => setEnv(idx, { value: e.target.value })} placeholder="value" />
						<button type="button" aria-label={`Remove variable ${idx + 1}`} className="text-muted-foreground hover:text-foreground px-1 transition" onClick={() => setPolicy({ envPairs: p.envPairs.filter((_, i) => i !== idx) })}>
							<X className="size-3" />
						</button>
					</div>
				))}
			</div>

			<div>
				<label className={label} htmlFor="lifecycle-json">
					Lifecycle JSON
				</label>
				<textarea
					id="lifecycle-json"
					className="placeholder:text-muted-foreground/50 min-h-24 w-full resize-y bg-transparent font-mono text-xs outline-hidden"
					value={p.lifecycleJson}
					onChange={(e) => setPolicy({ lifecycleJson: e.target.value })}
					spellCheck={false}
					placeholder={'{\n  "reset": {\n    "schedule": "@weekly",\n    "timezone": "UTC"\n  }\n}'}
				/>
			</div>

			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="text-muted-foreground flex items-center gap-3 text-xs">
					<label className="flex items-center gap-1.5">
						<input type="checkbox" checked={refreshOnlyIdle} onChange={(e) => setRefreshOnlyIdle(e.target.checked)} />
						<span>Idle only</span>
					</label>
					<label className="flex items-center gap-1.5">
						<input type="checkbox" checked={refreshReset} onChange={(e) => setRefreshReset(e.target.checked)} />
						<span>Reset persisted files</span>
					</label>
				</div>
				<div className="text-muted-foreground text-xs">Policy changes apply to newly provisioned terminals. Refresh matching terminals to apply them to existing terminals.</div>
				<Button type="button" variant="secondary" size="sm" disabled={refreshing} onClick={onRefresh}>
					{refreshing ? 'Refreshing...' : 'Refresh Terminals'}
				</Button>
			</div>
		</>
	);
}
