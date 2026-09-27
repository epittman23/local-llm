import { Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Tip } from '@/components/common/Tip';
import { AddTerminalServerModal } from '@/components/settings/AddTerminalServerModal';
import { AddToolServerModal } from '@/components/settings/AddToolServerModal';
import type { TerminalConnection } from '@/components/settings/terminalServerModel';
import type { ToolServerConnection } from '@/components/settings/toolServerModel';
import { Switch } from '@/components/ui/switch';
import { useUserSettings } from '@/lib/settings/userSettings';
import { SettingsForm, SettingsSection } from '../controls';

/**
 * Ports Settings/Integrations.svelte and Integrations/Terminals.svelte: the
 * user's own OpenAPI tool servers and Open Terminal servers ("direct"
 * connections, reached from the browser), each saved at once. Only one
 * terminal is enabled at a time, as before.
 *
 * Saved but not yet used by chat: this app has no browser-side executor for
 * direct servers (the Svelte layout's `execute:tool` socket handler) and does
 * not send `tool_servers`/`terminal_id` with a completion. Rather than let the
 * settings silently do nothing, the tab says so (docs/bug-review-2026-09-27.md
 * M9; listed with the deliberate gaps in docs/CLAUDE.md).
 */
export default function Integrations() {
	const { settings, update } = useUserSettings();
	const s = (settings ?? {}) as { toolServers?: ToolServerConnection[]; terminalServers?: TerminalConnection[] };
	const tools = s.toolServers ?? [];
	const terminals = s.terminalServers ?? [];
	const [toolModal, setToolModal] = useState<number | 'new' | null>(null);
	const [termModal, setTermModal] = useState<number | 'new' | null>(null);
	const save = (patch: Record<string, unknown>) => update(patch).catch((e) => toast.error(`${e}`));

	return (
		<SettingsForm title="Integrations" footer={false} loading={!settings}>
			<p role="note" className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-400">
				Not yet available in chat: servers added here are saved, but chats do not use personal tool or terminal servers in this version. Admin-configured tool servers are unaffected.
			</p>
			<SettingsSection title="Manage Tool Servers" first>
				<div className="flex items-center justify-between">
					<p className="text-muted-foreground text-xs">Connect to your own OpenAPI compatible external tool servers.</p>
					<Tip content="Add Connection">
						<button type="button" aria-label="Add Tool Server" className="hover:bg-muted rounded-md p-1" onClick={() => setToolModal('new')}>
							<Plus className="size-4" />
						</button>
					</Tip>
				</div>
				<ul className="flex flex-col gap-1" aria-label="Tool servers">
					{tools.map((t, i) => (
						<li key={i} className="flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs">
							<span className="min-w-0 flex-1 truncate">{t.info?.name ?? t.url}</span>
							<Switch aria-label={`Enable ${t.url}`} checked={t.config?.enable !== false} onCheckedChange={(v) => void save({ toolServers: tools.map((x, j) => (j === i ? { ...x, config: { ...(x.config ?? {}), enable: v } } : x)) })} />
							<button type="button" aria-label={`Edit ${t.url}`} className="hover:bg-muted rounded p-1" onClick={() => setToolModal(i)}>
								<Pencil className="size-3.5" />
							</button>
						</li>
					))}
				</ul>
			</SettingsSection>
			<SettingsSection title="Open Terminal">
				<div className="flex items-center justify-between">
					<p className="text-muted-foreground text-xs">Connect to a terminal server the model can use.</p>
					<Tip content="Add Connection">
						<button type="button" aria-label="Add Terminal" className="hover:bg-muted rounded-md p-1" onClick={() => setTermModal('new')}>
							<Plus className="size-4" />
						</button>
					</Tip>
				</div>
				<ul className="flex flex-col gap-1" aria-label="Terminal servers">
					{terminals.map((t, i) => (
						<li key={i} className="flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs">
							<span className="min-w-0 flex-1 truncate">{t.name || t.url}</span>
							<Switch aria-label={`Enable ${t.name || t.url}`} checked={Boolean(t.enabled)} onCheckedChange={(v) => void save({ terminalServers: terminals.map((x, j) => (v ? { ...x, enabled: j === i } : j === i ? { ...x, enabled: false } : x)) })} />
							<button type="button" aria-label={`Edit ${t.name || t.url}`} className="hover:bg-muted rounded p-1" onClick={() => setTermModal(i)}>
								<Pencil className="size-3.5" />
							</button>
						</li>
					))}
				</ul>
			</SettingsSection>
			<AddToolServerModal
				open={toolModal !== null}
				onOpenChange={(o) => !o && setToolModal(null)}
				direct
				edit={typeof toolModal === 'number'}
				connection={typeof toolModal === 'number' ? tools[toolModal] : null}
				onSubmit={async (c) => void (await save({ toolServers: toolModal === 'new' ? [...tools, c] : tools.map((x, i) => (i === toolModal ? c : x)) }))}
				onDelete={async () => void (await save({ toolServers: tools.filter((_, i) => i !== toolModal) }))}
			/>
			<AddTerminalServerModal
				open={termModal !== null}
				onOpenChange={(o) => !o && setTermModal(null)}
				direct
				edit={typeof termModal === 'number'}
				connection={typeof termModal === 'number' ? terminals[termModal] : null}
				onSubmit={async (c) => void (await save({ terminalServers: termModal === 'new' ? [...terminals, { ...c, enabled: c.enabled ?? false }] : terminals.map((x, i) => (i === termModal ? c : x)) }))}
				onDelete={async () => void (await save({ terminalServers: terminals.filter((_, i) => i !== termModal) }))}
			/>
		</SettingsForm>
	);
}
