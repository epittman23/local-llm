import { Plus, X } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { toast } from 'sonner';
import { AccessButton } from '@/components/common/AccessButton';
import { AccessControlModal } from '@/components/common/AccessControlModal';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { toastFailure } from '@/components/common/failureToast';
import { Spinner } from '@/components/common/Spinner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FieldMessage } from '@/components/ui/field-message';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
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
import { type TestResult, urlProblem } from './connectionModel';
import { ConnectionUrlField, Disclosure, FieldLabel, FormField, SecretInput, SelectField } from './formFields';
import {
	blankPolicy,
	buildPolicyData,
	buildTerminalConnection,
	type PolicyFields,
	parseLifecycle,
	policyFromServer,
	suggestPolicyId,
	type TerminalConnection,
	type TerminalFields,
	terminalFields
} from './terminalServerModel';
import { specRequestUrl } from './toolServerModel';

const AUTH_HELP: Record<string, string> = {
	none: 'Requests go without credentials.',
	session: "Sends the signed-in user's session credentials.",
	system_oauth: "Sends the signed-in user's OAuth access token."
};

const UPLOADS = [
	['default', 'Default'],
	['filesystem', 'Filesystem']
] as const;
const CHAT_CONTEXT = [
	['default', 'Shared'],
	['chat_id', 'Per chat'],
	['off', 'Off']
] as const;
const AUTOMATION_CONTEXT = [
	['default', 'Shared'],
	['automation_id', 'Per automation'],
	['off', 'Off']
] as const;
const STORAGE = [
	['ephemeral', 'Ephemeral'],
	['persistent', 'Persistent']
] as const;

/**
 * Ports components/AddTerminalServerModal.svelte: add or edit an Open Terminal
 * connection. Test connection asks the backend what the URL is (a plain
 * terminal or an Orchestrator); for an Orchestrator the admin can edit its
 * provisioning policy and lifecycle, which Save writes to the Orchestrator
 * *before* handing the connection to `onSubmit`, and can ask it to refresh
 * running terminals. With `direct` (Phase 10's personal terminals) there is no
 * ID, access control or policy, and the test runs from the browser. Rules in
 * terminalServerModel.ts.
 *
 * #933: the connection dialogs' one form language (see AddConnectionModal):
 * labelled shared fields, Orchestrator and Advanced behind chevron
 * disclosures, problems said under their fields; #1018: the test's result
 * under the URL.
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
	const ids = useId();
	const id = (name: string) => `${ids}-${name}`;
	const [f, setF] = useState<TerminalFields>(terminalFields(null));
	const [p, setP] = useState<PolicyFields>(blankPolicy());
	const [showAdvanced, setShowAdvanced] = useState(false);
	const [showOrchestrator, setShowOrchestrator] = useState(false);
	const [showAccess, setShowAccess] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [urlError, setUrlError] = useState<string | null>(null);
	const [lifecycleError, setLifecycleError] = useState<string | null>(null);
	const [refreshing, setRefreshing] = useState(false);
	const [saving, setSaving] = useState(false);
	const [loadingPolicy, setLoadingPolicy] = useState(false);
	const [policyError, setPolicyError] = useState('');
	const [refreshOnlyIdle, setRefreshOnlyIdle] = useState(true);
	const [refreshReset, setRefreshReset] = useState(false);
	const set = (patch: Partial<TerminalFields>) => {
		setF((prev) => ({ ...prev, ...patch }));
		if ('url' in patch) setUrlError(null);
	};
	const setPolicy = (patch: Partial<PolicyFields>) => {
		setP((prev) => ({ ...prev, ...patch }));
		if ('lifecycleJson' in patch) setLifecycleError(null);
	};
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
		setUrlError(null);
		setLifecycleError(null);
		setPolicyError('');
		setSaving(false);
		// An existing Orchestrator connection: read its policy and lifecycle back,
		// so Save does not overwrite them with the blank defaults.
		if (!connection || start.serverType !== 'orchestrator' || !start.policyId || direct) return;
		let cancelled = false;
		setLoadingPolicy(true);
		(async () => {
			try {
				const policy = await getOrchestratorPolicy(token, start.url, start.key, start.policyId, start.authType).catch(
					(error: any) => {
						if (error?.status !== 404) throw error;
						return null;
					}
				);
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

	const test = async (): Promise<TestResult | null> => {
		const url = f.url.trim().replace(/\/$/, '');
		const problem = urlProblem(url);
		if (problem) return { ok: false, text: problem };
		const failed = (error?: unknown): TestResult => ({
			ok: false,
			text: typeof error === 'string' && error ? error : "Couldn't reach a terminal there. Check the URL and the key."
		});
		try {
			if (direct) {
				return (await getTerminalConfig(url, f.key)) ? { ok: true, text: 'Reachable' } : failed();
			}
			// A system connection is checked by the backend: no CORS, and the key stays server-side.
			const result = await verifyTerminalServerConnection(token, { url, key: f.key, auth_type: f.authType });
			const type = result?.type ?? null;
			if (!type) {
				set({ serverType: null });
				return failed();
			}
			set({
				serverType: type,
				...(type === 'orchestrator' && !f.policyId ? { policyId: suggestPolicyId(f.id, f.name) } : {})
			});
			return { ok: true, text: `Reachable: ${type === 'orchestrator' ? 'an Orchestrator' : 'a terminal'}` };
		} catch (error) {
			set({ serverType: null });
			return failed(error);
		}
	};

	const refreshTerminals = async () => {
		setRefreshing(true);
		try {
			const result = await refreshOrchestratorTerminals(
				token,
				f.url,
				f.key,
				{ policy_id: f.policyId, only_idle: refreshOnlyIdle, reset: refreshReset },
				f.authType
			);
			const count = (result as { refreshed?: number } | null)?.refreshed ?? 0;
			toast.success(`Refreshing ${count} terminal${count === 1 ? '' : 's'}`);
		} catch (error) {
			toastFailure("Couldn't refresh the terminals.", error);
		} finally {
			setRefreshing(false);
		}
	};

	const submit = async () => {
		const problem = urlProblem(f.url);
		if (problem) {
			setUrlError(problem);
			setTimeout(() => document.getElementById(id('url'))?.focus());
			return;
		}
		if (loadingPolicy || policyError) return;
		const result = buildTerminalConnection(f, connection?.config, { direct });
		setSaving(true);
		try {
			if (orchestrator && f.policyId) {
				const lifecycle = parseLifecycle(p.lifecycleJson);
				if ('error' in lifecycle) {
					setShowOrchestrator(true);
					setLifecycleError('Enter the lifecycle as a JSON object, or leave it empty.');
					setTimeout(() => document.getElementById(id('lifecycle'))?.focus());
					return;
				}
				try {
					await putOrchestratorPolicy(
						token,
						result.url ?? '',
						result.key ?? '',
						f.policyId,
						buildPolicyData(p),
						f.authType
					);
					await putOrchestratorLifecycle(
						token,
						result.url ?? '',
						result.key ?? '',
						f.policyId,
						lifecycle.value,
						f.authType
					);
				} catch (error) {
					return void toastFailure("Couldn't save the Orchestrator's policy. The connection is not saved.", error);
				}
			}
			await onSubmit(result);
			onOpenChange(false);
		} finally {
			setSaving(false);
		}
	};

	const authOptions: [string, string][] = [
		['none', 'None'],
		['bearer', 'API key (Bearer)'],
		...(direct
			? []
			: ([
					['session', 'Session'],
					['system_oauth', 'OAuth']
				] as [string, string][]))
	];

	return (
		<>
			<ConfirmDialog
				open={confirmDelete}
				onOpenChange={setConfirmDelete}
				title={`Delete “${f.name || f.url || 'this terminal'}”?`}
				confirmLabel="Delete connection"
				destructive
				onConfirm={async () => {
					setConfirmDelete(false);
					await onDelete?.();
					onOpenChange(false);
				}}
			>
				Chats can no longer run commands on it. This can't be undone.
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
						<DialogTitle>{edit ? 'Edit terminal connection' : 'Add terminal connection'}</DialogTitle>
						<DialogDescription>An Open Terminal server, or an Orchestrator that starts one per chat.</DialogDescription>
					</DialogHeader>
					<form
						noValidate
						className="flex flex-col gap-4"
						onSubmit={(e) => {
							e.preventDefault();
							void submit();
						}}
					>
						<div className="grid gap-4 sm:grid-cols-2">
							<FormField id={id('name')} label="Name" optional>
								{(props) => (
									<Input {...props} value={f.name} onChange={(e) => set({ name: e.target.value })} autoComplete="off" />
								)}
							</FormField>
							{!direct && (
								<FormField id={id('id')} label="ID" optional help="Empty: one is made for it.">
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

						<ConnectionUrlField
							id={id('url')}
							value={f.url}
							onChange={(url) => set({ url })}
							placeholder="http://localhost:9900"
							error={urlError}
							onTest={test}
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
							<FormField id={id('key')} label="API key" optional>
								{(props) => <SecretInput {...props} value={f.key} onChange={(key) => set({ key })} />}
							</FormField>
						)}

						<FormField
							id={id('uploads')}
							label="Chat uploads"
							help="Filesystem puts the files a chat uploads into the terminal's files."
						>
							{(props) => (
								<SelectField
									{...props}
									className="sm:w-60"
									value={f.chatUploads}
									onChange={(chatUploads) => set({ chatUploads })}
									options={UPLOADS}
								/>
							)}
						</FormField>

						{orchestrator && (
							<Disclosure title="Orchestrator" open={showOrchestrator} onOpenChange={setShowOrchestrator}>
								<OrchestratorFields
									id={id}
									f={f}
									p={p}
									set={set}
									setPolicy={setPolicy}
									policyIdLocked={edit && Boolean(connection?.policy_id)}
									loadingPolicy={loadingPolicy}
									policyError={policyError}
									lifecycleError={lifecycleError}
									refreshOnlyIdle={refreshOnlyIdle}
									setRefreshOnlyIdle={setRefreshOnlyIdle}
									refreshReset={refreshReset}
									setRefreshReset={setRefreshReset}
									refreshing={refreshing}
									onRefresh={refreshTerminals}
								/>
							</Disclosure>
						)}

						<Disclosure title="Advanced" open={showAdvanced} onOpenChange={setShowAdvanced}>
							<FormField
								id={id('path')}
								label="Spec path or URL"
								help={`local-llm sends requests to ${specRequestUrl(f.url.trim().replace(/\/$/, ''), f.path)}`}
							>
								{(props) => (
									<Input {...props} value={f.path} onChange={(e) => set({ path: e.target.value })} autoComplete="off" />
								)}
							</FormField>
						</Disclosure>

						{loadingPolicy || policyError ? (
							<FieldMessage
								id={id('policy-state')}
								error={policyError ? `Couldn't load the Orchestrator's policy, so Save is off: ${policyError}` : null}
								help={loadingPolicy ? 'Loading the Orchestrator’s policy…' : undefined}
							/>
						) : null}

						<div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
							<div className="flex flex-wrap gap-2">
								{edit && (
									<Button type="button" variant="destructive" onClick={() => setConfirmDelete(true)}>
										Delete connection
									</Button>
								)}
								{!direct && <AccessButton label="Access control" onClick={() => setShowAccess(true)} />}
							</div>
							<Button
								type="submit"
								disabled={saving || loadingPolicy || Boolean(policyError)}
								aria-busy={saving || undefined}
							>
								{saving && <Spinner className="size-3.5" />}
								{saving ? 'Saving…' : 'Save'}
							</Button>
						</div>
					</form>
				</DialogContent>
			</Dialog>
		</>
	);
}

/** The Orchestrator block: terminal contexts, the policy, and Refresh terminals. */
function OrchestratorFields({
	id,
	f,
	p,
	set,
	setPolicy,
	policyIdLocked,
	loadingPolicy,
	policyError,
	lifecycleError,
	refreshOnlyIdle,
	setRefreshOnlyIdle,
	refreshReset,
	setRefreshReset,
	refreshing,
	onRefresh
}: {
	id: (name: string) => string;
	f: TerminalFields;
	p: PolicyFields;
	set: (patch: Partial<TerminalFields>) => void;
	setPolicy: (patch: Partial<PolicyFields>) => void;
	policyIdLocked: boolean;
	loadingPolicy: boolean;
	policyError: string;
	lifecycleError: string | null;
	refreshOnlyIdle: boolean;
	setRefreshOnlyIdle: (v: boolean) => void;
	refreshReset: boolean;
	setRefreshReset: (v: boolean) => void;
	refreshing: boolean;
	onRefresh: () => void;
}) {
	const setEnv = (idx: number, patch: Partial<{ key: string; value: string }>) =>
		setPolicy({ envPairs: p.envPairs.map((pair, i) => (i === idx ? { ...pair, ...patch } : pair)) });
	const policyReady = !loadingPolicy && !policyError;
	return (
		<div className="flex flex-col gap-4">
			<div className="grid gap-4 sm:grid-cols-2">
				<FormField id={id('chat-context')} label="Chat terminals">
					{(props) => (
						<SelectField
							{...props}
							value={f.chatContext}
							onChange={(chatContext) => set({ chatContext })}
							options={CHAT_CONTEXT}
						/>
					)}
				</FormField>
				<FormField id={id('automation-context')} label="Automation terminals">
					{(props) => (
						<SelectField
							{...props}
							value={f.automationContext}
							onChange={(automationContext) => set({ automationContext })}
							options={AUTOMATION_CONTEXT}
						/>
					)}
				</FormField>
			</div>

			<FormField
				id={id('policy-id')}
				label="Policy ID"
				help={policyIdLocked ? 'Fixed once saved: the Orchestrator keeps the policy under it.' : undefined}
			>
				{(props) => (
					<Input
						{...props}
						className="font-mono"
						value={f.policyId}
						onChange={(e) => set({ policyId: e.target.value })}
						placeholder="python-ds"
						autoComplete="off"
						disabled={policyIdLocked}
					/>
				)}
			</FormField>

			<FormField id={id('image')} label="Image" optional>
				{(props) => (
					<Input
						{...props}
						className="font-mono"
						value={p.image}
						onChange={(e) => setPolicy({ image: e.target.value })}
						placeholder="ghcr.io/open-webui/open-terminal:latest"
						autoComplete="off"
					/>
				)}
			</FormField>

			<div className="grid gap-4 sm:grid-cols-2">
				<FormField id={id('cpu')} label="CPU" optional>
					{(props) => (
						<Input
							{...props}
							className="font-mono"
							value={p.cpu}
							onChange={(e) => setPolicy({ cpu: e.target.value })}
							placeholder="1"
							autoComplete="off"
						/>
					)}
				</FormField>
				<FormField id={id('memory')} label="Memory" optional>
					{(props) => (
						<Input
							{...props}
							className="font-mono"
							value={p.memory}
							onChange={(e) => setPolicy({ memory: e.target.value })}
							placeholder="1Gi"
							autoComplete="off"
						/>
					)}
				</FormField>
				<FormField id={id('storage')} label="Storage">
					{(props) => (
						<SelectField
							{...props}
							value={p.storage}
							onChange={(storage) => setPolicy({ storage })}
							options={STORAGE}
						/>
					)}
				</FormField>
				{p.storage === 'persistent' && (
					<FormField id={id('storage-size')} label="Storage size">
						{(props) => (
							<Input
								{...props}
								className="font-mono"
								value={p.storageSize}
								onChange={(e) => setPolicy({ storageSize: e.target.value })}
								placeholder="5Gi"
								autoComplete="off"
							/>
						)}
					</FormField>
				)}
				<FormField id={id('idle')} label="Idle timeout, minutes">
					{(props) => (
						<Input
							{...props}
							className="font-mono"
							type="number"
							min={0}
							value={p.idleTimeout}
							onChange={(e) => setPolicy({ idleTimeout: e.target.value === '' ? 0 : Number(e.target.value) })}
						/>
					)}
				</FormField>
			</div>

			<div className="flex flex-col gap-2">
				<FieldLabel optional>Environment variables</FieldLabel>
				{p.envPairs.map((pair, idx) => (
					<div key={idx} className="flex items-center gap-2">
						<Input
							className="min-w-0 flex-1 font-mono"
							aria-label={`Variable ${idx + 1} name`}
							value={pair.key}
							onChange={(e) => setEnv(idx, { key: e.target.value })}
							placeholder="KEY"
						/>
						<Input
							className="min-w-0 flex-[2] font-mono"
							aria-label={`Variable ${idx + 1} value`}
							value={pair.value}
							onChange={(e) => setEnv(idx, { value: e.target.value })}
							placeholder="value"
						/>
						<Button
							variant="ghost"
							size="icon-sm"
							type="button"
							aria-label={`Remove variable ${idx + 1}`}
							onClick={() => setPolicy({ envPairs: p.envPairs.filter((_, i) => i !== idx) })}
						>
							<X aria-hidden />
						</Button>
					</div>
				))}
				<Button
					variant="outline"
					size="sm"
					type="button"
					className="self-start"
					onClick={() => setPolicy({ envPairs: [...p.envPairs, { key: '', value: '' }] })}
				>
					<Plus aria-hidden />
					Add variable
				</Button>
			</div>

			<FormField
				id={id('lifecycle')}
				label="Lifecycle"
				optional
				help='A JSON object, such as {"reset": {"schedule": "@weekly", "timezone": "UTC"}}.'
				error={lifecycleError}
			>
				{(props) => (
					<Textarea
						{...props}
						className="font-mono"
						rows={4}
						value={p.lifecycleJson}
						onChange={(e) => setPolicy({ lifecycleJson: e.target.value })}
						spellCheck={false}
					/>
				)}
			</FormField>

			<div className="flex flex-col gap-2 border-t pt-3">
				<p className="text-foreground-muted text-dense">
					A policy change applies to terminals started after it. Refresh the running ones to apply it to them too.
				</p>
				<div className="flex flex-wrap items-center gap-4">
					<div className="flex items-center gap-2">
						<Checkbox
							id={id('only-idle')}
							checked={refreshOnlyIdle}
							onCheckedChange={(v) => setRefreshOnlyIdle(v === true)}
						/>
						<Label htmlFor={id('only-idle')} className="text-body font-normal">
							Only idle terminals
						</Label>
					</div>
					<div className="flex items-center gap-2">
						<Checkbox id={id('reset')} checked={refreshReset} onCheckedChange={(v) => setRefreshReset(v === true)} />
						<Label htmlFor={id('reset')} className="text-body font-normal">
							Reset their saved files
						</Label>
					</div>
				</div>
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="self-start"
					disabled={refreshing || !f.policyId || !policyReady}
					aria-busy={refreshing || undefined}
					onClick={onRefresh}
				>
					{refreshing && <Spinner className="size-3.5" />}
					{refreshing ? 'Refreshing…' : 'Refresh terminals'}
				</Button>
				{!f.policyId && <FieldMessage id={id('refresh-help')} help="Enter a policy ID to refresh its terminals." />}
			</div>
		</div>
	);
}
