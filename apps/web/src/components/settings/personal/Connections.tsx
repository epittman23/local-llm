import { useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Tip } from '@/components/common/Tip';
import { AddConnectionModal } from '@/components/settings/AddConnectionModal';
import type { Connection } from '@/components/settings/connectionModel';
import { useUserSettings } from '@/lib/settings/userSettings';
import { SettingsForm, SettingsSection } from '../controls';

type Direct = {
	OPENAI_API_BASE_URLS: string[];
	OPENAI_API_KEYS: string[];
	OPENAI_API_CONFIGS: Record<number, unknown>;
};
const EMPTY: Direct = { OPENAI_API_BASE_URLS: [], OPENAI_API_KEYS: [], OPENAI_API_CONFIGS: {} };

/** Rebuilds the three parallel lists from a list of connections, trailing slashes removed (Connections.svelte's updateHandler). */
export function toDirect(list: Connection[]): Direct {
	return {
		OPENAI_API_BASE_URLS: list.map((c) => c.url.replace(/\/$/, '')),
		OPENAI_API_KEYS: list.map((c) => c.key ?? ''),
		OPENAI_API_CONFIGS: Object.fromEntries(list.map((c, i) => [i, c.config]))
	};
}
export function fromDirect(d: Direct | undefined | null): Connection[] {
	const x = d ?? EMPTY;
	return (x.OPENAI_API_BASE_URLS ?? []).map((url, i) => ({
		url,
		key: x.OPENAI_API_KEYS?.[i] ?? '',
		config: (x.OPENAI_API_CONFIGS?.[i] ?? {}) as Connection['config']
	}));
}

/**
 * Ports Settings/Connections.svelte: the user's own OpenAI-compatible
 * endpoints ("direct connections"), whose models are listed beside the
 * server's. Each change is saved at once.
 */
export default function Connections() {
	const { settings, update } = useUserSettings();
	const queryClient = useQueryClient();
	const list = fromDirect((settings as { directConnections?: Direct } | null)?.directConnections);
	const [adding, setAdding] = useState(false);
	const [editing, setEditing] = useState<number | null>(null);

	const save = async (next: Connection[]) => {
		await update({ directConnections: toDirect(next) }).catch((e) => toast.error(`${e}`));
		void queryClient.invalidateQueries({ queryKey: ['models-all'] });
	};

	return (
		<SettingsForm title="Connections" footer={false} loading={!settings}>
			<SettingsSection title="Manage Direct Connections" first>
				<div className="flex items-center justify-between">
					<p className="text-muted-foreground text-xs">Connect to your own OpenAI compatible API endpoints.</p>
					<Tip content="Add Connection">
						<button
							type="button"
							aria-label="Add Connection"
							className="hover:bg-muted rounded-md p-1"
							onClick={() => setAdding(true)}
						>
							<Plus className="size-4" />
						</button>
					</Tip>
				</div>
				<ul className="flex flex-col gap-1" aria-label="Direct connections">
					{list.map((c, i) => (
						<li key={i} className="flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs">
							<span className="min-w-0 flex-1 truncate">{c.url}</span>
							<button
								type="button"
								aria-label={`Edit ${c.url}`}
								className="hover:bg-muted rounded p-1"
								onClick={() => setEditing(i)}
							>
								<Pencil className="size-3.5" />
							</button>
						</li>
					))}
				</ul>
				{!list.length && <p className="text-muted-foreground text-xs">No connections yet.</p>}
			</SettingsSection>
			<AddConnectionModal open={adding} onOpenChange={setAdding} direct onSubmit={async (c) => save([...list, c])} />
			<AddConnectionModal
				open={editing !== null}
				onOpenChange={(o) => !o && setEditing(null)}
				direct
				edit
				connection={editing !== null ? list[editing] : null}
				onSubmit={async (c) => save(list.map((x, i) => (i === editing ? c : x)))}
				onDelete={async () => save(list.filter((_, i) => i !== editing))}
			/>
		</SettingsForm>
	);
}
