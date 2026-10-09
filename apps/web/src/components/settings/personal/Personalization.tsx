import { useQuery } from '@tanstack/react-query';
import { Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { Button } from '@/components/ui/button';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
	addNewMemory,
	deleteMemoriesByUserId,
	deleteMemoryById,
	getMemories,
	updateMemoryById
} from '@/lib/apis/memories';
import { useUserSettings } from '@/lib/settings/userSettings';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { dayjs } from '@/lib/utils/dates';
import { SettingRow, SettingSwitch, SettingsForm, SettingsSection } from '../controls';

type Memory = { id: string; content: string; type?: string; path?: string; updated_at?: number };

/** Ports Personalization/MemoryModal.svelte: add or edit one memory (a fact about the user, or context), with an optional path. */
function MemoryDialog({
	memory,
	onClose,
	onSaved
}: {
	memory: Memory | 'new' | null;
	onClose: () => void;
	onSaved: () => void;
}) {
	const token = useAuthStore((s) => s.token) ?? '';
	const edit = memory !== null && memory !== 'new';
	const [content, setContent] = useState(edit ? memory.content : '');
	const [type, setType] = useState(edit ? (memory.type ?? 'user') : 'user');
	const [path, setPath] = useState(edit ? (memory.path ?? '') : '');
	const [saving, setSaving] = useState(false);
	return (
		<Dialog open={memory !== null} onOpenChange={(o) => !o && onClose()}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>{edit ? 'Edit Memory' : 'Add Memory'}</DialogTitle>
					<DialogDescription className="sr-only">Something the model should remember about you</DialogDescription>
				</DialogHeader>
				<form
					className="flex flex-col gap-3"
					onSubmit={async (e) => {
						e.preventDefault();
						setSaving(true);
						try {
							if (edit) await updateMemoryById(token, memory.id, content, type, path);
							else await addNewMemory(token, content, type, path);
							toast.success(edit ? 'Memory updated successfully' : 'Memory added successfully');
							onSaved();
							onClose();
						} catch (err) {
							toast.error(`${err}`);
						}
						setSaving(false);
					}}
				>
					<label className="flex items-center justify-between text-xs">
						Type
						<select
							className="border-input h-8 rounded-md border bg-transparent px-2"
							value={type}
							onChange={(e) => setType(e.target.value)}
						>
							<option value="user">User</option>
							<option value="context">Context</option>
						</select>
					</label>
					<Textarea
						aria-label="Memory"
						required
						autoFocus
						placeholder={
							type === 'user'
								? 'Add a preference, fact, or instruction about you'
								: 'Add durable context for future chats'
						}
						value={content}
						onChange={(e) => setContent(e.target.value)}
					/>
					<label className="flex flex-col gap-1 text-xs">
						<span>
							Path <span className="opacity-50">(optional)</span>
						</span>
						<Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="e.g. work/projects" />
					</label>
					<DialogFooter>
						<Button type="submit" disabled={saving || !content.trim()}>
							Save
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/**
 * Ports Settings/Personalization.svelte: memory on or off (saved at once),
 * and the saved memories: search, add, edit, delete one, or clear them all.
 */
export default function Personalization() {
	const token = useAuthStore((s) => s.token) ?? '';
	const memoriesOn = Boolean(
		(useConfigStore((s) => s.config?.features) as Record<string, unknown> | undefined)?.enable_memories
	);
	const { settings, update } = useUserSettings();
	const memories = useQuery({
		queryKey: ['memories'],
		queryFn: async () => {
			const res = await getMemories(token).catch(() => null);
			return (Array.isArray(res) ? res : []) as Memory[];
		}
	});
	const [query, setQuery] = useState('');
	const [dialog, setDialog] = useState<Memory | 'new' | null>(null);
	const [deleting, setDeleting] = useState<Memory | null>(null);
	const [clearing, setClearing] = useState(false);
	const enabled = (settings as { memory?: boolean } | null)?.memory ?? memoriesOn;
	const q = query.trim().toLowerCase();
	const shown = (memories.data ?? []).filter(
		(m) =>
			!q ||
			m.content?.toLowerCase().includes(q) ||
			m.path?.toLowerCase().includes(q) ||
			m.type?.toLowerCase().includes(q)
	);

	return (
		<SettingsForm title="Personalization" footer={false}>
			<SettingsSection title="Memory" first>
				<SettingRow label="Memory" description="Let the model remember things you share across chats.">
					{(id) => <SettingSwitch labelledBy={id} checked={enabled} onChange={(v) => void update({ memory: v })} />}
				</SettingRow>
			</SettingsSection>
			<SettingsSection title="Saved Memories">
				<div className="flex items-center gap-2">
					<div className="relative flex-1">
						<Search className="text-muted-foreground absolute top-2 left-2 size-3.5" />
						<Input
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							placeholder="Search Memories"
							aria-label="Search Memories"
							className="h-7 pl-7 text-xs"
						/>
					</div>
					<Button type="button" size="sm" variant="outline" onClick={() => setDialog('new')}>
						<Plus className="size-3.5" /> Add Memory
					</Button>
				</div>
				<ul className="flex flex-col gap-1" aria-label="Memories">
					{shown.map((m) => (
						<li key={m.id} className="flex items-start gap-2 rounded-lg border px-2.5 py-1.5 text-xs">
							<div className="min-w-0 flex-1">
								<div className="whitespace-pre-wrap">{m.content}</div>
								<div className="text-muted-foreground mt-0.5">
									{m.type === 'context' ? 'Context' : 'User'}
									{m.path ? ` · ${m.path}` : ''}
									{m.updated_at ? ` · ${dayjs(m.updated_at * 1000).format('LL')}` : ''}
								</div>
							</div>
							<button
								type="button"
								aria-label="Edit memory"
								className="hover:bg-muted rounded p-1"
								onClick={() => setDialog(m)}
							>
								<Pencil className="size-3.5" />
							</button>
							<button
								type="button"
								aria-label="Delete memory"
								className="hover:bg-muted rounded p-1"
								onClick={() => setDeleting(m)}
							>
								<Trash2 className="size-3.5" />
							</button>
						</li>
					))}
				</ul>
				{!memories.isLoading && !shown.length && <p className="text-muted-foreground text-xs">No memories yet.</p>}
				{(memories.data?.length ?? 0) > 0 && (
					<div>
						<Button
							type="button"
							size="sm"
							variant="ghost"
							className="text-destructive"
							onClick={() => setClearing(true)}
						>
							Clear memory
						</Button>
					</div>
				)}
			</SettingsSection>
			{dialog !== null && (
				<MemoryDialog
					key={typeof dialog === 'string' ? 'new' : dialog.id}
					memory={dialog}
					onClose={() => setDialog(null)}
					onSaved={() => void memories.refetch()}
				/>
			)}
			<ConfirmDialog
				open={deleting !== null}
				onOpenChange={(o) => !o && setDeleting(null)}
				title="Delete memory?"
				confirmLabel="Delete"
				onConfirm={async () => {
					if (!deleting) return;
					await deleteMemoryById(token, deleting.id).catch((e) => toast.error(`${e}`));
					void memories.refetch();
				}}
			>
				This memory will be forgotten.
			</ConfirmDialog>
			<ConfirmDialog
				open={clearing}
				onOpenChange={setClearing}
				title="Clear memory?"
				confirmLabel="Clear"
				onConfirm={async () => {
					await deleteMemoriesByUserId(token).then(
						() => toast.success('Memory cleared successfully'),
						(e) => toast.error(`${e}`)
					);
					void memories.refetch();
				}}
			>
				Every saved memory will be deleted.
			</ConfirmDialog>
		</SettingsForm>
	);
}
