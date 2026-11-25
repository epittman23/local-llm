import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { toastFailure } from '@/components/common/failureToast';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { searchNotes } from '@/lib/apis/notes';
import { useAuthStore } from '@/lib/stores/authStore';
import { cn } from '@/lib/utils';
import { useDebouncedValue } from '@/lib/utils/useDebouncedValue';
import { type SaveTarget, saveReplyToNote } from '@/routes/notes/noteChat';
import { PINNED_NOTES_KEY } from '@/routes/notes/notesModel';

type Mode = 'new' | 'existing';

/**
 * "Save to note" on an assistant reply: the reply's Markdown, as written, goes
 * into a new note (titled after the chat, editable) or at the end of one
 * chosen from the user's notes (#1135). Saying so is a toast with Open (FBK-2);
 * a refusal is a toast and the dialog stays, so the choice is not lost (FBK-4).
 */
export function SaveToNoteDialog({
	open,
	onOpenChange,
	markdown,
	chatTitle
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	markdown: string;
	chatTitle: string;
}) {
	const token = useAuthStore((s) => s.token) ?? '';
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [mode, setMode] = useState<Mode>('new');
	const [title, setTitle] = useState(chatTitle);
	const [query, setQuery] = useState('');
	const search = useDebouncedValue(query, 250);
	const [chosen, setChosen] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const notes = useQuery({
		queryKey: ['notes', 'save-targets', search],
		enabled: open && mode === 'existing',
		queryFn: async () => {
			const items = (await searchNotes(token, search || null))?.items;
			return (Array.isArray(items) ? items : []) as {
				id: string;
				title: string;
			}[];
		}
	});

	const target: SaveTarget | null =
		mode === 'new' ? { kind: 'new', title } : chosen ? { kind: 'existing', id: chosen } : null;
	const ready = target !== null;
	const save = async () => {
		if (saving || !target) return;
		setSaving(true);
		try {
			const saved = await saveReplyToNote(token, target, markdown);
			onOpenChange(false);
			toast.success(`Saved to "${saved.title}"`, {
				action: {
					label: 'Open',
					onClick: () => navigate(`/notes/${saved.id}`)
				}
			});
			void queryClient.invalidateQueries({ queryKey: ['notes'] });
			void queryClient.invalidateQueries({ queryKey: PINNED_NOTES_KEY });
		} catch (error) {
			toastFailure("Couldn't save the reply to the note. Try again.", error);
		} finally {
			setSaving(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Save to note</DialogTitle>
					<DialogDescription className="sr-only">
						Save this reply to a new note or add it to an existing one.
					</DialogDescription>
				</DialogHeader>
				<form
					className="flex flex-col gap-4"
					onSubmit={(e) => {
						e.preventDefault();
						void save();
					}}
				>
					<SegmentedControl
						aria-label="Where to save"
						value={mode}
						onValueChange={setMode}
						options={[
							{ value: 'new', label: 'New note' },
							{ value: 'existing', label: 'Add to an existing note' }
						]}
					/>
					{mode === 'new' ? (
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="save-note-title">Title</Label>
							<Input
								id="save-note-title"
								autoFocus
								value={title}
								onChange={(e) => setTitle(e.target.value)}
								placeholder="Untitled"
								autoComplete="off"
							/>
						</div>
					) : (
						<div className="flex flex-col gap-2">
							<div className="relative">
								<Search aria-hidden className="text-foreground-muted absolute top-2.5 left-2.5 size-4" />
								<Input
									autoFocus
									value={query}
									onChange={(e) => setQuery(e.target.value)}
									placeholder="Search notes"
									aria-label="Search notes"
									className="pl-8"
								/>
							</div>
							<div className="max-h-60 overflow-y-auto" role="listbox" aria-label="Notes">
								{notes.isLoading ? (
									<div className="flex justify-center py-6">
										<Spinner className="size-4" />
									</div>
								) : notes.isError ? (
									<p className="text-foreground-muted py-6 text-center text-body">
										Couldn't load your notes.{' '}
										<Button type="button" variant="link" size="xs" onClick={() => void notes.refetch()}>
											Try again
										</Button>
									</p>
								) : !notes.data?.length ? (
									<p className="text-foreground-muted py-6 text-center text-body">No notes found</p>
								) : (
									notes.data.map((n) => (
										<Button
											key={n.id}
											type="button"
											role="option"
											aria-selected={chosen === n.id}
											variant="ghost"
											className={cn('w-full justify-start', chosen === n.id && 'bg-surface-3')}
											onClick={() => setChosen(n.id)}
										>
											<span className="truncate">{n.title || 'Untitled'}</span>
										</Button>
									))
								)}
							</div>
						</div>
					)}
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						<Button
							type="submit"
							aria-disabled={saving || !ready || undefined}
							className={cn(
								(saving || !ready) && 'text-foreground-disabled hover:text-foreground-disabled cursor-not-allowed'
							)}
						>
							{saving && <Spinner className="size-4" />}
							Save
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
