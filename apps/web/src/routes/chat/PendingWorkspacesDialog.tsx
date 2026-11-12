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
	type PendingWorkspaces
} from '@/lib/apis/sandbox';
import { useAuthStore } from '@/lib/stores/authStore';
import { formatSecondsTimestamp } from '@/lib/utils/dates';
import { formatFileSize } from '@/lib/utils/files';

const title = (t: string | null | undefined) => t || 'Untitled chat';

/** Why this workspace waits, in the user's terms. */
function reasonText(item: PendingWorkspace, data: PendingWorkspaces): string {
	if (item.reason === 'expired') {
		const days = data.retention_days ? ` for more than ${data.retention_days} days` : '';
		return `Not used${days} (last used ${formatSecondsTimestamp(item.last_used_at)}). Remove it to free its disk, or keep it.`;
	}
	const limit = data.max_workspaces ? ` (${data.max_workspaces})` : '';
	return `"${title(item.waiting_chat_title)}" needs a code workspace, and you have the most allowed${limit}. Remove one to make room, or keep them all: that chat then runs no code until you remove one.`;
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
							{contents.files.map((f) => (
								<tr key={f.path} className="border-t">
									<td className="px-2 py-1 break-all">{f.path}</td>
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
	onAnswered
}: {
	item: PendingWorkspace;
	data: PendingWorkspaces;
	onAnswered: (gone: string[]) => void;
}) {
	const token = useAuthStore((s) => s.token) ?? '';
	const [target, setTarget] = useState(item.id);
	const [busy, setBusy] = useState(false);
	const others = item.reason === 'cap' ? (item.workspaces ?? []) : [];

	const answer = async (action: 'remove' | 'keep') => {
		setBusy(true);
		try {
			await answerPendingWorkspace(token, item.id, action, action === 'remove' ? target : undefined);
			toast.success(action === 'remove' ? 'Workspace removed.' : 'Workspace kept.');
			// The answered request goes, and so does a removed workspace's own, if it had one.
			onAnswered(action === 'remove' ? [item.id, target] : [item.id]);
		} catch (err) {
			toast.error(errorMessage(err, 'The answer could not be saved.'));
		} finally {
			setBusy(false);
		}
	};

	return (
		<section
			className="space-y-2 rounded-lg border p-3"
			aria-label={`Workspace of ${title(item.chat_title)}`}
			data-testid="pending-workspace"
		>
			<div className="flex flex-wrap items-baseline justify-between gap-2">
				<h3 className="text-sm font-medium">{title(item.chat_title)}</h3>
				<span className="text-muted-foreground text-xs">
					{item.reason === 'cap' ? 'Workspace limit reached' : 'Unused'}
				</span>
			</div>
			<p className="text-xs">{reasonText(item, data)}</p>
			<Contents item={item} />
			{others.length > 0 && (
				<label className="flex flex-col gap-1 text-xs">
					<span className="font-medium">Workspace to remove</span>
					<select
						className="border-input bg-background rounded-md border px-2 py-1 text-xs"
						value={target}
						onChange={(e) => setTarget(e.target.value)}
						disabled={busy}
						aria-label="Workspace to remove"
					>
						<option value={item.id}>
							{title(item.chat_title)} (last used {formatSecondsTimestamp(item.last_used_at)})
						</option>
						{others.map((w) => (
							<option key={w.id} value={w.id}>
								{title(w.chat_title)} (last used {formatSecondsTimestamp(w.last_used_at)})
							</option>
						))}
					</select>
				</label>
			)}
			<div className="flex justify-end gap-2">
				<Button size="sm" variant="outline" disabled={busy} onClick={() => answer('keep')}>
					Keep
				</Button>
				<Button size="sm" variant="destructive" disabled={busy} onClick={() => answer('remove')}>
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
	// The answered items leave the list as it is, without listing the others again; then the ids are asked anew.
	const answered = (gone: string[]) => {
		const left = waiting.filter((id) => !gone.includes(id));
		if (details.data) {
			queryClient.setQueryData<PendingWorkspaces>(detailsKey(left), {
				...details.data,
				pending: details.data.pending.filter((p) => left.includes(p.id))
			});
		}
		queryClient.setQueryData<string[]>(PENDING_WORKSPACE_IDS_KEY, left);
		void queryClient.invalidateQueries({ queryKey: PENDING_WORKSPACE_IDS_KEY });
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
					<p className="text-destructive text-sm">The workspaces could not be listed: {errorMessage(details.error)}</p>
				) : (
					<div className="space-y-3">
						{details.data.pending.map((item) => (
							<PendingItem key={item.id} item={item} data={details.data} onAnswered={answered} />
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
