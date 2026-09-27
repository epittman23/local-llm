import { useQuery } from '@tanstack/react-query';
import { Cloud, Plus, Settings, Wrench } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Tip } from '@/components/common/Tip';
import { SettingsForm, SettingsSection } from '@/components/settings/controls';
import { AddTerminalServerModal } from '@/components/settings/AddTerminalServerModal';
import { AddToolServerModal } from '@/components/settings/AddToolServerModal';
import type { TerminalConnection } from '@/components/settings/terminalServerModel';
import type { ToolServerConnection } from '@/components/settings/toolServerModel';
import { Switch } from '@/components/ui/switch';
import { getTerminalServerConnections, getToolServerConnections, setTerminalServerConnections, setToolServerConnections } from '@/lib/apis/configs';
import { useAuthStore } from '@/lib/stores/authStore';
import { ExternalKnowledge } from './ExternalKnowledge';

const iconButton = 'text-muted-foreground hover:text-foreground rounded p-1 transition';
const hint = 'text-muted-foreground/70 text-[0.6875rem]';

/** A connection row: icon and label (dimmed when off), a configure cog, an enable switch. */
function ConnectionRow({ icon, label, detail, enabled, onConfigure, onToggle }: { icon: ReactNode; label: string; detail?: string; enabled: boolean; onConfigure: () => void; onToggle: (on: boolean) => void }) {
	return (
		<li className="flex w-full items-center gap-2 text-xs">
			<div className={`flex min-w-0 flex-1 items-center gap-1.5 ${enabled ? '' : 'opacity-50'}`}>
				{icon}
				<div className="min-w-0 truncate">
					{label} {detail && <span className="text-muted-foreground">{detail}</span>}
				</div>
			</div>
			<div className="flex shrink-0 items-center gap-1">
				<Tip content="Configure">
					<button type="button" aria-label={`Configure ${label}`} className={iconButton} onClick={onConfigure}>
						<Settings className="size-4" />
					</button>
				</Tip>
				<Tip content={enabled ? 'Enabled' : 'Disabled'}>
					<span>
						<Switch size="sm" aria-label={`${enabled ? 'Disable' : 'Enable'} ${label}`} checked={enabled} onCheckedChange={onToggle} />
					</span>
				</Tip>
			</div>
		</li>
	);
}

function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
	return (
		<Tip content="Add Connection">
			<button type="button" aria-label={label} className={iconButton} onClick={onClick}>
				<Plus className="size-4" />
			</button>
		</Tip>
	);
}

/**
 * Ports admin/Settings/Integrations.svelte: external tool servers (OpenAPI or
 * MCP), Open Terminal connections, and external knowledge sources.
 *
 * As in the original, every change saves at once -- adding, editing, toggling
 * or deleting a server writes that whole list -- and the Save button re-saves
 * the tool servers. Not ported: refreshing the app-wide `terminalServers`
 * store after a terminal save, since the chat that reads it is Phase 10; the
 * query key below is the hook for it.
 */
export default function Integrations() {
	const token = useAuthStore((s) => s.token) ?? '';
	const [servers, setServers] = useState<ToolServerConnection[] | null>(null);
	const [terminals, setTerminals] = useState<TerminalConnection[]>([]);
	const [addingServer, setAddingServer] = useState(false);
	const [editServerIdx, setEditServerIdx] = useState<number | null>(null);
	const [terminalModal, setTerminalModal] = useState<{ idx: number | null } | null>(null);

	const loaded = useQuery({
		queryKey: ['admin-settings', 'integrations'],
		queryFn: async () => {
			const tools = await getToolServerConnections(token);
			// Terminal servers may simply not be configured yet.
			const term = await getTerminalServerConnections(token).catch(() => null);
			return { servers: (tools?.TOOL_SERVER_CONNECTIONS ?? []) as ToolServerConnection[], terminals: (term?.TERMINAL_SERVER_CONNECTIONS ?? []) as TerminalConnection[] };
		},
		gcTime: 0,
		staleTime: Infinity,
		refetchOnWindowFocus: false
	});
	useEffect(() => {
		if (!loaded.data || servers) return;
		setServers(loaded.data.servers);
		setTerminals(loaded.data.terminals);
	}, [loaded.data, servers]);
	useEffect(() => {
		if (loaded.isError) toast.error(`${loaded.error}`);
	}, [loaded.isError, loaded.error]);

	const saveServers = async (next: ToolServerConnection[]) => {
		setServers(next);
		const res = await setToolServerConnections(token, { TOOL_SERVER_CONNECTIONS: next }).catch(() => null);
		if (res) toast.success('Connections saved successfully');
		else toast.error('Failed to save connections');
	};

	const saveTerminals = async (next: TerminalConnection[]) => {
		setTerminals(next);
		const res = await setTerminalServerConnections(token, { TERMINAL_SERVER_CONNECTIONS: next }).catch(() => null);
		if (res) toast.success('Terminal servers saved');
		else toast.error('Failed to save terminal servers');
	};

	const editedServer = editServerIdx === null ? null : (servers?.[editServerIdx] ?? null);
	const editedTerminal = terminalModal?.idx == null ? null : (terminals[terminalModal.idx] ?? null);

	return (
		<SettingsForm title="Integrations" loading={!servers} onSubmit={() => saveServers(servers ?? [])}>
			<AddToolServerModal open={addingServer} onOpenChange={setAddingServer} onSubmit={(c) => saveServers([...(servers ?? []), c])} />
			<AddToolServerModal
				open={editServerIdx !== null}
				onOpenChange={(open) => !open && setEditServerIdx(null)}
				edit
				connection={editedServer}
				onSubmit={(c) => saveServers((servers ?? []).map((s, i) => (i === editServerIdx ? c : s)))}
				onDelete={() => saveServers((servers ?? []).filter((_, i) => i !== editServerIdx))}
			/>
			<AddTerminalServerModal
				open={terminalModal !== null}
				onOpenChange={(open) => !open && setTerminalModal(null)}
				edit={terminalModal?.idx != null}
				connection={editedTerminal}
				onSubmit={(c) => {
					const idx = terminalModal?.idx;
					if (idx == null) return saveTerminals([...terminals, { ...c, id: c.id ?? crypto.randomUUID() }]);
					return saveTerminals(terminals.map((t, i) => (i === idx ? { ...t, ...c, id: c.id ?? t.id } : t)));
				}}
				onDelete={() => saveTerminals(terminals.filter((_, i) => i !== terminalModal?.idx))}
			/>

			<SettingsSection title="Tools" first>
				<div>
					<div className="mb-2 flex items-center justify-between">
						<div className="text-muted-foreground text-xs">External Tool Servers</div>
						<AddButton label="Add Tool Server" onClick={() => setAddingServer(true)} />
					</div>
					<ul className="flex flex-col gap-1">
						{(servers ?? []).map((server, idx) => {
							const enabled = server.config?.enable ?? true;
							const name = server.info?.name as string | undefined;
							return (
								<ConnectionRow
									key={idx}
									icon={
										<Tip content={server.type === 'mcp' ? 'MCP' : 'OpenAPI'}>
											<Wrench className="size-4 shrink-0" strokeWidth={1.5} />
										</Tip>
									}
									label={name || server.url}
									detail={name ? (server.info?.id as string) || undefined : undefined}
									enabled={enabled}
									onConfigure={() => setEditServerIdx(idx)}
									onToggle={(on) => saveServers((servers ?? []).map((s, i) => (i === idx ? { ...s, config: { ...s.config, enable: on } } : s)))}
								/>
							);
						})}
					</ul>
					{servers?.length === 0 && <div className={hint}>No tool server connections configured.</div>}
					<div className={`${hint} mt-1`}>Connect to your own OpenAPI compatible external tool servers.</div>
				</div>
			</SettingsSection>

			<SettingsSection title="Terminal">
				<div>
					<div className="mb-2 flex items-center justify-between">
						<div className="text-muted-foreground text-xs">Open Terminal</div>
						<AddButton label="Add Terminal Connection" onClick={() => setTerminalModal({ idx: null })} />
					</div>
					<ul className="flex flex-col gap-1.5">
						{terminals.map((t, idx) => (
							<ConnectionRow
								key={t.id ?? idx}
								icon={
									<Tip content="Terminal">
										<Cloud className="size-4 shrink-0" strokeWidth={1.5} />
									</Tip>
								}
								label={t.name || t.url || 'New Terminal'}
								enabled={t.enabled !== false}
								onConfigure={() => setTerminalModal({ idx })}
								onToggle={(on) => saveTerminals(terminals.map((c, i) => (i === idx ? { ...c, enabled: on } : c)))}
							/>
						))}
					</ul>
					{terminals.length === 0 && <div className={hint}>No terminal connections configured.</div>}
					<div className={`${hint} mt-1`}>Connect to Open Terminal instances. Admins and users granted access can use file browsing and terminal tools through these servers.</div>
					<a className="text-muted-foreground hover:text-foreground mt-0.5 block text-[0.6875rem] underline" href="https://github.com/open-webui/open-terminal" target="_blank" rel="noreferrer">
						Learn more about Open Terminal ↗
					</a>
				</div>
			</SettingsSection>

			<SettingsSection title="Knowledge">
				<ExternalKnowledge />
			</SettingsSection>
		</SettingsForm>
	);
}
