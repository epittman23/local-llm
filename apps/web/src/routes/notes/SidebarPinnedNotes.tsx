import { useQuery } from '@tanstack/react-query';
import { NotebookText } from 'lucide-react';
import { NavLink } from 'react-router';
import { Button } from '@/components/ui/button';
import { canUseFeature } from '@/lib/access/features';
import { getPinnedNoteList } from '@/lib/apis/notes';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { cn } from '@/lib/utils';
import { PINNED_NOTES_KEY, pinnedList } from './notesModel';

/**
 * The sidebar's Pinned notes (#963, S6-D3): the notes pinned from the Notes
 * list or a note's menu, each a link to the note. Nothing at all while notes
 * are off for this account or none is pinned; a failed load says so in place,
 * with Try again (STA-4).
 */
export function SidebarPinnedNotes({ onNavigate }: { onNavigate?: () => void }) {
	const token = useAuthStore((s) => s.token) ?? '';
	const user = useAuthStore((s) => s.user);
	const config = useConfigStore((s) => s.config);
	const enabled = canUseFeature('notes', user, config) && Boolean(token);
	const pinned = useQuery({
		queryKey: PINNED_NOTES_KEY,
		queryFn: async () => pinnedList(await getPinnedNoteList(token)),
		enabled
	});
	if (!enabled) return null;
	const header = <div className="text-foreground-muted text-caption font-strong px-2 py-1">Pinned notes</div>;
	if (pinned.isError)
		return (
			<section aria-label="Pinned notes" className="mt-3">
				{header}
				<div role="alert" className="text-dense text-foreground-muted flex items-center gap-2 px-2 py-1">
					Couldn't load pinned notes.
					<Button
						type="button"
						variant="ghost"
						size="xs"
						onClick={() => void pinned.refetch()}
						disabled={pinned.isFetching}
					>
						{pinned.isFetching ? 'Trying again…' : 'Try again'}
					</Button>
				</div>
			</section>
		);
	const notes = pinned.data ?? [];
	if (notes.length === 0) return null;
	return (
		<section aria-label="Pinned notes" className="mt-3">
			{header}
			<ul className="flex flex-col gap-0.5">
				{notes.map((n) => (
					<li key={n.id}>
						<NavLink
							to={`/notes/${n.id}`}
							onClick={onNavigate}
							className={({ isActive }) =>
								cn(
									'flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm pointer-coarse:min-h-11',
									isActive ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
								)
							}
						>
							<NotebookText aria-hidden className="text-foreground-muted size-3.5 shrink-0" />
							<span className="truncate">{n.title || 'Untitled'}</span>
						</NavLink>
					</li>
				))}
			</ul>
		</section>
	);
}
