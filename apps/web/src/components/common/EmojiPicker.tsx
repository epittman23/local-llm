import { type ReactNode, useMemo, useState } from 'react';
import { Spinner } from '@/components/common/Spinner';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { searchEmojis, useEmojiIndex } from '@/lib/emoji/emoji';

/**
 * Ports common/EmojiPicker.svelte: a searchable popover of every emoji, by
 * group, that submits the chosen emoji's shortcode. Not ported: the "Recently
 * Used" row (it writes to user settings on every pick) and the virtual list;
 * the grid renders only the matches for the current search, capped, which
 * keeps the DOM small without one.
 */
export function EmojiPicker({ children, onSubmit, onOpenChange }: { children: ReactNode; onSubmit: (name: string) => void; onOpenChange?: (open: boolean) => void }) {
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState('');
	const index = useEmojiIndex();
	const matches = useMemo(() => (index && open ? searchEmojis(index, search).slice(0, 400) : []), [index, search, open]);

	const change = (next: boolean) => {
		setOpen(next);
		if (!next) setSearch('');
		onOpenChange?.(next);
	};

	return (
		<Popover open={open} onOpenChange={change}>
			<PopoverTrigger asChild>{children}</PopoverTrigger>
			<PopoverContent align="start" side="top" className="w-72 p-2">
				<Input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search emojis" aria-label="Search emojis" className="mb-2 h-8" />
				{!index ? (
					<div className="flex justify-center py-6">
						<Spinner className="size-4" />
					</div>
				) : matches.length === 0 ? (
					<div className="text-muted-foreground py-6 text-center text-xs">No results</div>
				) : (
					<div className="grid max-h-60 grid-cols-8 gap-0.5 overflow-y-auto" role="listbox" aria-label="Emojis">
						{matches.map((e) => (
							<button
								key={`${e.group}-${e.name}`}
								type="button"
								role="option"
								aria-selected={false}
								title={`:${e.name}:`}
								aria-label={e.name}
								className="hover:bg-muted flex size-8 items-center justify-center rounded text-xl"
								onClick={() => {
									onSubmit(e.name);
									change(false);
								}}
							>
								{e.char}
							</button>
						))}
					</div>
				)}
			</PopoverContent>
		</Popover>
	);
}

/** A shortcode drawn as its emoji, or as `:name:` when it is not one this app knows. */
export function Emoji({ name, className }: { name: string; className?: string }) {
	const index = useEmojiIndex();
	const char = index?.byName[name];
	return <span className={className}>{char ?? `:${name}:`}</span>;
}
