import { useQuery } from '@tanstack/react-query';
import { Cloud, Pencil, Plus, Wrench } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { toastFailure } from '@/components/common/failureToast';
import { LoadFailed } from '@/components/common/LoadFailed';
import { AddTerminalServerModal } from '@/components/settings/AddTerminalServerModal';
import { AddToolServerModal } from '@/components/settings/AddToolServerModal';
import { SettingsForm, SettingsSection } from '@/components/settings/controls';
import type { TerminalConnection } from '@/components/settings/terminalServerModel';
import type { ToolServerConnection } from '@/components/settings/toolServerModel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
	getTerminalServerConnections,
	getToolServerConnections,
	setTerminalServerConnections,
	setToolServerConnections
} from '@/lib/apis/configs';
import { useAuthStore } from '@/lib/stores/authStore';
import { uuid } from '@/lib/utils/uuid';
import { ExternalKnowledge } from './ExternalKnowledge';

/**
 * A connection row: icon, name and detail, its state as badges (Off; never a
 * faded row, DAT-3, COL-2), Edit, and the enable switch, outside any tooltip
 * (#912).
 */
function ConnectionRow({
	icon,
	label,
	detail,
	kind,
	enabled,
	onConfigure,
	onToggle
}: {
	icon: ReactNode;
	label: string;
	detail?: string;
	kind?: string;
	enabled: boolean;
	onConfigure: () => void;
	onToggle: (on: boolean) => void;
}) {
	return (
		<li className="flex w-full min-w-0 items-center gap-2 text-body">
			<span className="text-foreground-muted flex shrink-0">{icon}</span>
			<span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
				<span className="min-w-0 truncate">{label}</span>
				{detail && <span className="text-foreground-muted min-w-0 truncate font-mono text-dense">{detail}</span>}
				{kind && <Badge variant="secondary">{kind}</Badge>}
				{!enabled && (
					<Badge variant="secondary">
						<span className="sr-only">, </span>Off
					</Badge>
				)}
			</span>
			<Button variant="ghost" size="icon-sm" type="button" aria-label={`Edit ${label}`} onClick={onConfigure}>
				<Pencil aria-hidden />
			</Button>
			<Switch aria-label={`Enable ${label}`} checked={enabled} onCheckedChange={onToggle} />
		</li>
	);
}

function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
	return (
		<Button variant="outline" size="sm" type="button" className="self-start" onClick={onClick}>
			<Plus aria-hidden />
			{label}
		</Button>
	);
}

/**
 * Ports admin/Settings/Integrations.svelte: external tool servers (OpenAPI or
 * MCP), Open Terminal connections, and external knowledge sources.
 *
 * Every change saves at once (FRM-3, `savesAtOnce`) -- adding, editing,
 * toggling or deleting a server writes that whole list -- and says what it
 * saved in one toast, or why it couldn't, putting the old list back. Not ported: refreshing the app-wide `terminalServers`
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
			return {
				servers: (tools?.TOOL_SERVER_CONNECTIONS ?? []) as ToolServerConnection[],
				terminals: (term?.TERMINAL_SERVER_CONNECTIONS ?? []) as TerminalConnection[]
			};
		},
		retry: false,
		gcTime: 0,
		staleTime: Infinity,
		refetchOnWindowFocus: false
	});
	useEffect(() => {
		if (!loaded.data || servers) return;
		setServers(loaded.data.servers);
		setTerminals(loaded.data.terminals);
	}, [loaded.data, servers]);

	/**
	 * Saves the whole tool server list, showing it at once and putting the old
	 * one back if the server refuses it. Throws after saying why, so a dialog
	 * that asked for the save stays open.
	 */
	const saveServers = async (next: ToolServerConnection[], done: string) => {
		const prev = servers;
		setServers(next);
		try {
			const res = await setToolServerConnections(token, { TOOL_SERVER_CONNECTIONS: next });
			if (!res) throw new Error('The server returned nothing.');
		} catch (error) {
			setServers(prev);
			toastFailure("Couldn't save the tool servers.", error);
			throw error;
		}
		toast.success(done);
	};

	/** The same for the terminal list. */
	const saveTerminals = async (next: TerminalConnection[], done: string) => {
		const prev = terminals;
		setTerminals(next);
		try {
			const res = await setTerminalServerConnections(token, { TERMINAL_SERVER_CONNECTIONS: next });
			if (!res) throw new Error('The server returned nothing.');
		} catch (error) {
			setTerminals(prev);
			toastFailure("Couldn't save the terminal connections.", error);
			throw error;
		}
		toast.success(done);
	};
	const quiet = (save: Promise<void>) => void save.catch(() => {});
	const serverName = (s: ToolServerConnection) => `“${(s.info?.name as string | undefined) || s.url}”`;
	const terminalName = (t: TerminalConnection) => `“${t.name || t.url || 'New terminal'}”`;

	const editedServer = editServerIdx === null ? null : (servers?.[editServerIdx] ?? null);
	const editedTerminal = terminalModal?.idx == null ? null : (terminals[terminalModal.idx] ?? null);

	if (loaded.isError) {
		return (
			<SettingsForm title="Integrations" savesAtOnce>
				<LoadFailed
					what="the integrations"
					error={loaded.error}
					retrying={loaded.isFetching}
					onRetry={() => void loaded.refetch()}
				/>
			</SettingsForm>
		);
	}

	return (
		<SettingsForm title="Integrations" loading={!servers} savesAtOnce>
			<AddToolServerModal
				open={addingServer}
				onOpenChange={setAddingServer}
				onSubmit={(c) => saveServers([...(servers ?? []), c], `${serverName(c)} added`)}
			/>
			<AddToolServerModal
				open={editServerIdx !== null}
				onOpenChange={(open) => !open && setEditServerIdx(null)}
				edit
				connection={editedServer}
				onSubmit={(c) =>
					saveServers(
						(servers ?? []).map((s, i) => (i === editServerIdx ? c : s)),
						`${serverName(c)} saved`
					)
				}
				onDelete={async () => {
					if (!editedServer) return;
					await saveServers(
						(servers ?? []).filter((_, i) => i !== editServerIdx),
						`${serverName(editedServer)} deleted`
					).catch(() => {});
				}}
			/>
			<AddTerminalServerModal
				open={terminalModal !== null}
				onOpenChange={(open) => !open && setTerminalModal(null)}
				edit={terminalModal?.idx != null}
				connection={editedTerminal}
				onSubmit={(c) => {
					const idx = terminalModal?.idx;
					if (idx == null)
						return saveTerminals([...terminals, { ...c, id: c.id ?? uuid() }], `${terminalName(c)} added`);
					return saveTerminals(
						terminals.map((t, i) => (i === idx ? { ...t, ...c, id: c.id ?? t.id } : t)),
						`${terminalName(c)} saved`
					);
				}}
				onDelete={async () => {
					if (!editedTerminal) return;
					await saveTerminals(
						terminals.filter((_, i) => i !== terminalModal?.idx),
						`${terminalName(editedTerminal)} deleted`
					).catch(() => {});
				}}
			/>

			<SettingsSection title="Tools" first>
				<div className="flex flex-col gap-2">
					<p className="text-foreground-muted text-dense">OpenAPI and MCP servers whose tools chats can call.</p>
					{(servers ?? []).length > 0 ? (
						<ul aria-label="Tool servers" className="flex flex-col gap-2">
							{(servers ?? []).map((server, idx) => {
								const enabled = server.config?.enable ?? true;
								const name = server.info?.name as string | undefined;
								return (
									<ConnectionRow
										key={idx}
										icon={<Wrench aria-hidden className="size-4" />}
										label={name || server.url}
										detail={name ? (server.info?.id as string) || undefined : undefined}
										kind={server.type === 'mcp' ? 'MCP' : 'OpenAPI'}
										enabled={enabled}
										onConfigure={() => setEditServerIdx(idx)}
										onToggle={(on) =>
											quiet(
												saveServers(
													(servers ?? []).map((s, i) =>
														i === idx ? { ...s, config: { ...s.config, enable: on } } : s
													),
													`${serverName(server)} is ${on ? 'on' : 'off'}`
												)
											)
										}
									/>
								);
							})}
						</ul>
					) : (
						<p className="text-foreground-muted text-dense">None yet.</p>
					)}
					<AddButton label="Add tool server" onClick={() => setAddingServer(true)} />
				</div>
			</SettingsSection>

			<SettingsSection title="Terminal">
				<div className="flex flex-col gap-2">
					<p className="text-foreground-muted text-dense">
						Open Terminal servers for file browsing and terminal tools, used by admins and the users given access.
					</p>
					{terminals.length > 0 ? (
						<ul aria-label="Terminal connections" className="flex flex-col gap-2">
							{terminals.map((t, idx) => (
								<ConnectionRow
									key={t.id ?? idx}
									icon={<Cloud aria-hidden className="size-4" />}
									label={t.name || t.url || 'New terminal'}
									enabled={t.enabled !== false}
									onConfigure={() => setTerminalModal({ idx })}
									onToggle={(on) =>
										quiet(
											saveTerminals(
												terminals.map((c, i) => (i === idx ? { ...c, enabled: on } : c)),
												`${terminalName(t)} is ${on ? 'on' : 'off'}`
											)
										)
									}
								/>
							))}
						</ul>
					) : (
						<p className="text-foreground-muted text-dense">None yet.</p>
					)}
					<AddButton label="Add terminal connection" onClick={() => setTerminalModal({ idx: null })} />
				</div>
			</SettingsSection>

			<SettingsSection title="Knowledge">
				<ExternalKnowledge />
			</SettingsSection>
		</SettingsForm>
	);
}
