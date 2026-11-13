import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Spinner } from '@/components/common/Spinner';
import { Button } from '@/components/ui/button';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle
} from '@/components/ui/dialog';
import { errorMessage } from '@/lib/apis/errors';
import {
	answerPendingWorkspace,
	getPendingWorkspaceIds,
	getPendingWorkspaces,
	PENDING_WORKSPACE_IDS_KEY,
	type PendingWorkspace,
	type PendingWorkspaces,
	type WorkspaceFile
} from '@/lib/apis/sandbox';
import { useAuthStore } from '@/lib/stores/authStore';
import { formatSecondsTimestamp } from '@/lib/utils/dates';
import { formatFileSize } from '@/lib/utils/files';

const title = (t: string | null | undefined) => t || 'Untitled chat';
/**
 * A name the model or user chose, isolated from the text around it (U+2068 FIRST STRONG ISOLATE ... U+2069 POP
 * DIRECTIONAL ISOLATE), for places that take text only, such as an <option>: a right-to-left override in a chat
 * title or a file name cannot reorder the words around it. In markup, <bdi> does the same.
 */
const isolated = (t: string) => `\u2068${t}\u2069`;

/** The most of a chat title an <option> shows: an option cannot wrap, and a native <select> grows to its longest one. */
export const OPTION_TITLE_MAX = 60;

// Direction controls a title may carry (embeddings, overrides, isolates): dropped from an option, so a cut cannot
// leave one open and our own isolate always closes what it opened.
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g;

const graphemes = (t: string): string[] =>
	typeof Intl.Segmenter === 'function'
		? Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(t), (g) => g.segment)
		: Array.from(t);

/**
 * A chat title as a <select> option shows it: without direction controls, cut at OPTION_TITLE_MAX characters as the
 * reader sees them (grapheme clusters, so an emoji sequence or a letter and its accents stay whole) with an ellipsis,
 * and isolated.
 */
export const optionTitle = (t: string | null | undefined) => {
	const chars = graphemes(title(t).replace(BIDI_CONTROLS, ''));
	return isolated(
		chars.length > OPTION_TITLE_MAX ? `${chars.slice(0, OPTION_TITLE_MAX - 1).join('')}\u2026` : chars.join('')
	);
};

/** Why this workspace waits, in the user's terms. */
function reasonText(item: PendingWorkspace, data: PendingWorkspaces): string {
	if (item.reason === 'expired') {
		const days = data.retention_days ? ` for more than ${data.retention_days} days` : '';
		return `Not used${days} (last used ${formatSecondsTimestamp(item.last_used_at)}). Remove it to free its disk, or keep it.`;
	}
	const limit = data.max_workspaces ? ` (${data.max_workspaces})` : '';
	return `"${isolated(title(item.waiting_chat_title))}" needs a code workspace, and you have the most allowed${limit}. Remove one to make room, or keep them all: that chat then runs no code until you remove one.`;
}

/**
 * Each file with a key unique in the list: its path, and how many times that path came before, since a name cut
 * short, or with bad bytes replaced, can repeat another's.
 */
function rowKeys(files: WorkspaceFile[]): [string, WorkspaceFile][] {
	const seen = new Map<string, number>();
	return files.map((f) => {
		const n = seen.get(f.path) ?? 0;
		seen.set(f.path, n + 1);
		return [`${n}:${f.path}`, f];
	});
}

/** The workspace's files as the server listed them, capped, with totals over all of them. */
function Contents({ item }: { item: PendingWorkspace }) {
	const contents = item.contents;
	if (!contents) {
		return <p className="text-muted-foreground text-xs">{item.contents_error ?? 'The contents are unknown.'}</p>;
	}
	const shown = contents.files.length;
	return (
		<div className="space-y-1">
			<p className="text-muted-foreground text-xs" data-testid="workspace-totals">
				{contents.file_count === 1 ? '1 file' : `${contents.file_count} files`}, {formatFileSize(contents.total_bytes)}
				{shown < contents.file_count ? ` (the first ${shown} shown)` : ''}
				{contents.complete ? '' : '; some folders could not be read'}
			</p>
			{shown > 0 && (
				<div className="max-h-40 overflow-auto rounded-md border">
					<table className="w-full text-xs">
						<thead className="bg-muted/50 sticky top-0">
							<tr className="text-left">
								<th className="px-2 py-1 font-medium">File</th>
								<th className="px-2 py-1 text-right font-medium">Size</th>
								<th className="px-2 py-1 text-right font-medium">Modified</th>
							</tr>
						</thead>
						<tbody>
							{rowKeys(contents.files).map(([key, f]) => (
								<tr key={key} className="border-t">
									<td className="px-2 py-1 break-all">
										<bdi>{f.path}</bdi>
										{f.truncated ? <span className="text-muted-foreground"> (name shortened)</span> : null}
									</td>
									<td className="px-2 py-1 text-right whitespace-nowrap">{formatFileSize(f.size)}</td>
									<td className="px-2 py-1 text-right whitespace-nowrap">
										{formatSecondsTimestamp(Math.floor(f.mtime))}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}

const detailsKey = (ids: string[]) => ['sandbox', 'pending-workspace-details', ids.join(',')];

function PendingItem({
	item,
	data,
	onAnswered,
	onFailed
}: {
	item: PendingWorkspace;
	data: PendingWorkspaces;
	onAnswered: (answered: string, removed: string | null) => void;
	onFailed: () => void;
}) {
	const token = useAuthStore((s) => s.token) ?? '';
	const [target, setTarget] = useState(item.id);
	const [busy, setBusy] = useState(false);
	const others = item.reason === 'cap' ? (item.workspaces ?? []) : [];

	const answer = async (action: 'remove' | 'keep') => {
		setBusy(true);
		try {
			await answerPendingWorkspace(token, item.id, action, item.since ?? 0, action === 'remove' ? target : undefined);
			toast.success(action === 'remove' ? 'Workspace removed.' : 'Workspace kept.');
			onAnswered(item.id, action === 'remove' ? target : null);
		} catch (err) {
			toast.error(errorMessage(err, 'The answer could not be saved.'));
			// The request may have changed or gone meanwhile (404, 409): show the list as it is now.
			onFailed();
		} finally {
			setBusy(false);
		}
	};

	return (
		<section
			className="min-w-0 space-y-2 rounded-lg border p-3"
			aria-label={`Workspace of ${title(item.chat_title)}`}
			data-testid="pending-workspace"
		>
			<div className="flex flex-wrap items-baseline justify-between gap-2">
				<h3 className="min-w-0 text-sm font-medium break-words">
					<bdi>{title(item.chat_title)}</bdi>
				</h3>
				<span className="text-muted-foreground text-xs">
					{item.reason === 'cap' ? 'Workspace limit reached' : 'Unused'}
				</span>
			</div>
			<p className="text-xs break-words">{reasonText(item, data)}</p>
			<Contents item={item} />
			{others.length > 0 && (
				<label className="flex min-w-0 flex-col gap-1 text-xs">
					<span className="font-medium">Workspace to remove</span>
					<select
						className="border-input bg-background w-full max-w-full min-w-0 truncate rounded-md border px-2 py-1 text-xs"
						value={target}
						onChange={(e) => setTarget(e.target.value)}
						disabled={busy}
						aria-label="Workspace to remove"
					>
						<option value={item.id}>
							{optionTitle(item.chat_title)} (last used {formatSecondsTimestamp(item.last_used_at)})
						</option>
						{others.map((w) => (
							<option key={w.id} value={w.id}>
								{optionTitle(w.chat_title)} (last used {formatSecondsTimestamp(w.last_used_at)})
							</option>
						))}
					</select>
				</label>
			)}
			<div className="flex justify-end gap-2">
				<Button
					size="sm"
					variant="outline"
					disabled={busy}
					onClick={() => answer('keep')}
					aria-label={`Keep workspace of ${title(item.chat_title)}`}
				>
					Keep
				</Button>
				<Button
					size="sm"
					variant="destructive"
					disabled={busy}
					onClick={() => answer('remove')}
					aria-label={`Remove workspace of ${title(item.chat_title)}`}
				>
					{busy ? <Spinner className="size-3" /> : null}
					Remove
				</Button>
			</div>
		</section>
	);
}

/**
 * The workspace deletion dialog (owner decision Q15): shown, once signed in,
 * whenever the user has sandbox workspaces whose deletion waits for an answer,
 * either unused for the retention days or asked about because another chat hit
 * the workspace limit. Nothing is deleted without an answer. The ids are asked
 * for on load and again whenever PENDING_WORKSPACES_KEY is invalidated (a reply
 * finishing, useChatSession), so a tool call that hit the limit shows it at
 * once. Closing it without answering hides it until a new request arrives or
 * the app is loaded again.
 */
export function PendingWorkspacesDialog() {
	const token = useAuthStore((s) => s.token) ?? '';
	const queryClient = useQueryClient();
	const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
	const ids = useQuery({
		queryKey: PENDING_WORKSPACE_IDS_KEY,
		queryFn: ({ signal }) => getPendingWorkspaceIds(token, signal),
		enabled: Boolean(token),
		retry: false,
		refetchOnWindowFocus: false
	});
	const waiting = ids.data ?? [];
	const open = waiting.some((id) => !dismissed.has(id));
	// Keyed by the ids, so a new request lists again; kept until then, since each listing may start a VM.
	const details = useQuery({
		queryKey: detailsKey(waiting),
		queryFn: ({ signal }) => getPendingWorkspaces(token, signal),
		enabled: open,
		retry: false,
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnWindowFocus: false
	});
	const close = () => setDismissed(new Set([...dismissed, ...waiting]));
	// The answered items leave the list as it is, without listing the others again, and a removed workspace leaves
	// every other item's choices; then the ids are asked anew.
	const answered = (request: string, removed: string | null) => {
		// The answered request goes, and so does a removed workspace's own request, if it had one.
		const left = waiting.filter((id) => id !== request && id !== removed);
		if (details.data) {
			queryClient.setQueryData<PendingWorkspaces>(detailsKey(left), {
				...details.data,
				pending: details.data.pending
					.filter((p) => left.includes(p.id))
					.map((p) => (p.workspaces ? { ...p, workspaces: p.workspaces.filter((w) => w.id !== removed) } : p))
			});
		}
		queryClient.setQueryData<string[]>(PENDING_WORKSPACE_IDS_KEY, left);
		void queryClient.invalidateQueries({ queryKey: PENDING_WORKSPACE_IDS_KEY });
	};
	// After a refused answer: the ids and the list are asked again, as they are now.
	const failed = () => {
		void queryClient.invalidateQueries({ queryKey: PENDING_WORKSPACE_IDS_KEY });
		void queryClient.invalidateQueries({ queryKey: detailsKey(waiting) });
	};

	return (
		<Dialog open={open} onOpenChange={(next) => !next && close()}>
			<DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>Code workspaces waiting for your answer</DialogTitle>
					<DialogDescription>
						Each saved chat that ran code keeps its files in a workspace. Nothing is deleted until you choose.
					</DialogDescription>
				</DialogHeader>
				{details.isPending ? (
					<div className="flex items-center gap-2 text-sm">
						<Spinner className="size-4" /> Listing the workspaces...
					</div>
				) : details.isError ? (
					<div className="flex items-center gap-2">
						<p className="text-destructive text-sm">
							The workspaces could not be listed: {errorMessage(details.error)}
						</p>
						<Button size="sm" variant="outline" onClick={() => void details.refetch()}>
							Retry
						</Button>
					</div>
				) : (
					<div className="min-w-0 space-y-3">
						{details.data.pending.map((item) => (
							<PendingItem key={item.id} item={item} data={details.data} onAnswered={answered} onFailed={failed} />
						))}
					</div>
				)}
				<DialogFooter>
					<Button variant="ghost" onClick={close}>
						Decide later
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
