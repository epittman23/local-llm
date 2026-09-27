import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import saveAs from 'file-saver';
import { Link2Off, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { InfiniteLoader } from '@/components/common/InfiniteLoader';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { archiveAllChats, deleteAllChats, deleteSharedChatById, getAllChats, getSharedChatList, importChats } from '@/lib/apis/chats';
import { deleteFileById, getFiles } from '@/lib/apis/files';
import { importPayload, parseChatExport } from '@/lib/chat/importChats';
import { useAuthStore } from '@/lib/stores/authStore';
import { dayjs } from '@/lib/utils/dates';
import { SettingRow, SettingsForm, SettingsSection } from '../controls';

type Row = { id: string; title?: string; filename?: string; updated_at?: number; created_at?: number; share_id?: string };

/** Ports layout/SharedChatsModal.svelte: chats the user has shared, each of which can be unshared. */
function SharedChatsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
	const token = useAuthStore((s) => s.token) ?? '';
	const list = useInfiniteQuery({
		queryKey: ['shared-chats'],
		enabled: open,
		initialPageParam: 1,
		queryFn: async ({ pageParam }) => {
			const res = await getSharedChatList(token, pageParam).catch(() => null);
			return (Array.isArray(res) ? res : []) as Row[];
		},
		getNextPageParam: (last, pages) => (last.length ? pages.length + 1 : undefined)
	});
	const rows = (list.data?.pages ?? []).flat();
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle>Shared Chats</DialogTitle>
					<DialogDescription className="sr-only">Chats you have shared by link</DialogDescription>
				</DialogHeader>
				<ul className="max-h-96 overflow-y-auto text-sm" aria-label="Shared chats">
					{rows.map((c) => (
						<li key={c.id} className="flex items-center gap-2 border-b py-1.5 last:border-0">
							<span className="min-w-0 flex-1 truncate">{c.title}</span>
							<button
								type="button"
								aria-label={`Unshare ${c.title}`}
								className="hover:bg-muted rounded p-1"
								onClick={async () => {
									await deleteSharedChatById(token, c.id).catch((e) => toast.error(`${e}`));
									void list.refetch();
								}}
							>
								<Link2Off className="size-3.5" />
							</button>
						</li>
					))}
					{list.hasNextPage && <InfiniteLoader onVisible={() => !list.isFetchingNextPage && void list.fetchNextPage()} />}
				</ul>
				{!list.isLoading && !rows.length && <p className="text-muted-foreground text-sm">You have no shared chats.</p>}
			</DialogContent>
		</Dialog>
	);
}

/** Ports layout/FilesModal.svelte (list and delete): the files the user has uploaded. */
function FilesDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
	const token = useAuthStore((s) => s.token) ?? '';
	const files = useQuery({ queryKey: ['user-files'], enabled: open, queryFn: async () => {
		const res = await getFiles(token).catch(() => null);
		return (Array.isArray(res) ? res : []) as Row[];
	} });
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle>Files</DialogTitle>
					<DialogDescription className="sr-only">Files you have uploaded</DialogDescription>
				</DialogHeader>
				<ul className="max-h-96 overflow-y-auto text-sm" aria-label="Files">
					{(files.data ?? []).map((f) => (
						<li key={f.id} className="flex items-center gap-2 border-b py-1.5 last:border-0">
							<span className="min-w-0 flex-1 truncate">{f.filename}</span>
							{f.created_at ? <span className="text-muted-foreground text-xs">{dayjs(f.created_at * 1000).format('LL')}</span> : null}
							<button
								type="button"
								aria-label={`Delete ${f.filename}`}
								className="hover:bg-muted rounded p-1"
								onClick={async () => {
									await deleteFileById(token, f.id).catch((e) => toast.error(`${e}`));
									void files.refetch();
								}}
							>
								<Trash2 className="size-3.5" />
							</button>
						</li>
					))}
				</ul>
				{!files.isLoading && !files.data?.length && <p className="text-muted-foreground text-sm">No files.</p>}
			</DialogContent>
		</Dialog>
	);
}

/**
 * Ports Settings/DataControls.svelte: import chats (this app's export, or a
 * ChatGPT export, converted), export them all, review shared chats,
 * archive or delete every chat after a confirmation, and manage files.
 */
export default function DataControls() {
	const token = useAuthStore((s) => s.token) ?? '';
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const input = useRef<HTMLInputElement>(null);
	const [confirm, setConfirm] = useState<'archive' | 'delete' | null>(null);
	const [shared, setShared] = useState(false);
	const [filesOpen, setFilesOpen] = useState(false);
	const refresh = () => queryClient.invalidateQueries({ queryKey: ['chats'] });

	const importFile = async (file: File | undefined) => {
		if (!file) return;
		try {
			const chats = parseChatExport(await file.text());
			const res = (await importChats(token, importPayload(chats))) as unknown[] | null;
			if (res) toast.success(`Successfully imported ${res.length} chats.`);
		} catch (e) {
			toast.error(`${e instanceof Error ? e.message : e}`);
		}
		void refresh();
	};

	return (
		<SettingsForm title="Data Controls" footer={false}>
			<input ref={input} type="file" accept=".json,application/json" hidden aria-label="Import chats file" onChange={(e) => void importFile(e.target.files?.[0]).then(() => (e.target.value = ''))} />
			<SettingsSection title="Chats" first>
				<SettingRow label="Import Chats" description="Import chat history from a JSON export file.">
					<Button type="button" size="sm" variant="outline" onClick={() => input.current?.click()}>
						Import
					</Button>
				</SettingRow>
				<SettingRow label="Export Chats" description="Download your chat history as a JSON export.">
					<Button type="button" size="sm" variant="outline" onClick={async () => saveAs(new Blob([JSON.stringify(await getAllChats(token))], { type: 'application/json' }), `chat-export-${Date.now()}.json`)}>
						Export
					</Button>
				</SettingRow>
				<SettingRow label="Shared Chats" description="Review and manage chats you have shared.">
					<Button type="button" size="sm" variant="outline" onClick={() => setShared(true)}>
						Manage
					</Button>
				</SettingRow>
				<SettingRow label="Archive All Chats" description="Move every chat into the archive after confirmation.">
					<Button type="button" size="sm" variant="outline" onClick={() => setConfirm('archive')}>
						Archive All
					</Button>
				</SettingRow>
				<SettingRow label="Delete All Chats" description="Permanently delete every chat after confirmation.">
					<Button type="button" size="sm" variant="outline" className="text-destructive" onClick={() => setConfirm('delete')}>
						Delete All
					</Button>
				</SettingRow>
			</SettingsSection>
			<SettingsSection title="Files">
				<SettingRow label="Manage Files" description="Open the file manager for uploaded files.">
					<Button type="button" size="sm" variant="outline" onClick={() => setFilesOpen(true)}>
						Manage
					</Button>
				</SettingRow>
			</SettingsSection>
			<ConfirmDialog
				open={confirm !== null}
				onOpenChange={(o) => !o && setConfirm(null)}
				title={confirm === 'archive' ? 'Archive All Chats' : 'Delete All Chats'}
				confirmLabel={confirm === 'archive' ? 'Archive All' : 'Delete All'}
				onConfirm={async () => {
					navigate('/');
					await (confirm === 'archive' ? archiveAllChats(token) : deleteAllChats(token)).catch((e) => toast.error(`${e}`));
					void refresh();
				}}
			>
				{confirm === 'archive' ? 'Are you sure you want to archive all chats? This action cannot be undone.' : 'Are you sure you want to delete all chats? This action cannot be undone.'}
			</ConfirmDialog>
			<SharedChatsDialog open={shared} onOpenChange={setShared} />
			<FilesDialog open={filesOpen} onOpenChange={setFilesOpen} />
		</SettingsForm>
	);
}
