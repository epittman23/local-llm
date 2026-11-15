import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import saveAs from 'file-saver';
import { Copy, Link2Off, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { InfiniteLoader } from '@/components/common/InfiniteLoader';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
	archiveAllChats,
	deleteAllChats,
	deleteSharedChatById,
	getAllChats,
	getSharedChatList,
	importChats
} from '@/lib/apis/chats';
import { deleteFileById, getFiles } from '@/lib/apis/files';
import { importPayload, parseChatExport } from '@/lib/chat/importChats';
import { useAuthStore } from '@/lib/stores/authStore';
import { copyToClipboard } from '@/lib/utils';
import { dayjs } from '@/lib/utils/dates';
import { appHref } from '@/routes/routePaths';
import { ChatTime, SettingRow, SettingsForm, SettingsSection } from '../controls';

type Row = {
	id: string;
	title?: string;
	filename?: string;
	updated_at?: number;
	created_at?: number;
	share_id?: string;
};

/** GET /chats/shared answers 60 rows a page (routers/chats.py); a shorter page is the last. */
const SHARED_PAGE_SIZE = 60;

/**
 * Ports layout/SharedChatsModal.svelte: chats the user has shared, each with
 * its link (opened or copied) and a Stop sharing button (#1006).
 */
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
		getNextPageParam: (last, pages) => (last.length >= SHARED_PAGE_SIZE ? pages.length + 1 : undefined)
	});
	const rows = (list.data?.pages ?? []).flat();
	const link = (c: Row) => appHref(`/s/${c.share_id ?? c.id}`);
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>Shared chats</DialogTitle>
					<DialogDescription>Chats anyone with the link can open. Stop sharing to turn a link off.</DialogDescription>
				</DialogHeader>
				<ul className="max-h-96 overflow-y-auto" aria-label="Shared chats">
					{rows.map((c) => (
						<li key={c.id} className="flex flex-wrap items-center gap-2 border-b py-2 last:border-0">
							<div className="min-w-0 flex-1">
								<a
									href={link(c)}
									target="_blank"
									rel="noreferrer"
									className="block truncate hover:underline"
									title={c.title}
								>
									{c.title}
								</a>
								<span className="text-foreground-muted text-dense">
									<ChatTime seconds={c.updated_at} />
								</span>
							</div>
							<Button
								variant="ghost"
								size="sm"
								type="button"
								aria-label={`Copy link to ${c.title}`}
								onClick={async () => {
									if (await copyToClipboard(`${window.location.origin}${link(c)}`)) toast.success('Link copied');
									else toast.error('The link could not be copied.');
								}}
							>
								<Copy aria-hidden />
								Copy link
							</Button>
							<Button
								variant="outline"
								size="sm"
								type="button"
								aria-label={`Stop sharing ${c.title}`}
								onClick={async () => {
									await deleteSharedChatById(token, c.id).then(
										() => toast.success('Stopped sharing'),
										(e) => toast.error(`${e}`)
									);
									void list.refetch();
								}}
							>
								<Link2Off aria-hidden />
								Stop sharing
							</Button>
						</li>
					))}
					{list.hasNextPage && (
						<InfiniteLoader onVisible={() => !list.isFetchingNextPage && void list.fetchNextPage()} />
					)}
				</ul>
				{!list.isLoading && !rows.length && (
					<p className="text-foreground-muted">No shared chats. Share a chat from its menu to get a link.</p>
				)}
			</DialogContent>
		</Dialog>
	);
}

/** Ports layout/FilesModal.svelte (list and delete): the files the user has uploaded. */
function FilesDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
	const token = useAuthStore((s) => s.token) ?? '';
	const files = useQuery({
		queryKey: ['user-files'],
		enabled: open,
		queryFn: async () => {
			const res = await getFiles(token).catch(() => null);
			return (Array.isArray(res) ? res : []) as Row[];
		}
	});
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle>Uploaded files</DialogTitle>
					<DialogDescription className="sr-only">Files you have uploaded</DialogDescription>
				</DialogHeader>
				<ul className="max-h-96 overflow-y-auto text-sm" aria-label="Files">
					{(files.data ?? []).map((f) => (
						<li key={f.id} className="flex items-center gap-2 border-b py-1.5 last:border-0">
							<span className="min-w-0 flex-1 truncate">{f.filename}</span>
							{f.created_at ? (
								<span className="text-muted-foreground text-xs">{dayjs(f.created_at * 1000).format('LL')}</span>
							) : null}
							<Button
								variant="ghost"
								size="icon-xs"
								type="button"
								aria-label={`Delete ${f.filename}`}
								onClick={async () => {
									await deleteFileById(token, f.id).catch((e) => toast.error(`${e}`));
									void files.refetch();
								}}
							>
								<Trash2 className="size-3.5" />
							</Button>
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
		<SettingsForm title="Data controls" footer={false}>
			<input
				ref={input}
				type="file"
				accept=".json,application/json"
				hidden
				aria-label="Import chats file"
				onChange={(e) => void importFile(e.target.files?.[0]).then(() => (e.target.value = ''))}
			/>
			<SettingsSection title="Chats" first>
				<SettingRow label="Import" description="Add chats from a JSON export (this app's, or ChatGPT's).">
					<Button type="button" variant="outline" onClick={() => input.current?.click()}>
						Import chats
					</Button>
				</SettingRow>
				<SettingRow label="Export" description="Download every chat as one JSON file.">
					<Button
						type="button"
						variant="outline"
						onClick={async () =>
							saveAs(
								new Blob([JSON.stringify(await getAllChats(token))], { type: 'application/json' }),
								`chat-export-${Date.now()}.json`
							)
						}
					>
						Export chats
					</Button>
				</SettingRow>
				<SettingRow label="Shared chats" description="See the links you have shared, copy one, or stop sharing.">
					<Button type="button" variant="outline" onClick={() => setShared(true)}>
						Manage shared chats
					</Button>
				</SettingRow>
				<SettingRow label="Archive everything" description="Move every chat out of the sidebar into the archive.">
					<Button type="button" variant="outline" onClick={() => setConfirm('archive')}>
						Archive all chats
					</Button>
				</SettingRow>
				<SettingRow label="Delete everything" description="Delete every chat and its messages for good.">
					<Button type="button" variant="destructive" onClick={() => setConfirm('delete')}>
						Delete all chats
					</Button>
				</SettingRow>
			</SettingsSection>
			<SettingsSection title="Files">
				<SettingRow label="Uploaded files" description="See and delete the files you have uploaded.">
					<Button type="button" variant="outline" onClick={() => setFilesOpen(true)}>
						Manage files
					</Button>
				</SettingRow>
			</SettingsSection>
			<ConfirmDialog
				open={confirm !== null}
				onOpenChange={(o) => !o && setConfirm(null)}
				title={confirm === 'archive' ? 'Archive all chats?' : 'Delete all chats?'}
				confirmLabel={confirm === 'archive' ? 'Archive all chats' : 'Delete all chats'}
				onConfirm={async () => {
					navigate('/');
					await (confirm === 'archive' ? archiveAllChats(token) : deleteAllChats(token)).then(
						() => toast.success(confirm === 'archive' ? 'All chats archived' : 'All chats deleted'),
						(e) => toast.error(`${e}`)
					);
					void refresh();
				}}
			>
				{confirm === 'archive'
					? 'Every chat leaves the sidebar. You can unarchive them from Archived chats.'
					: 'Every chat and its messages are deleted. This cannot be undone.'}
			</ConfirmDialog>
			<SharedChatsDialog open={shared} onOpenChange={setShared} />
			<FilesDialog open={filesOpen} onOpenChange={setFilesOpen} />
		</SettingsForm>
	);
}
