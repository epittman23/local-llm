import { X } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

type Tag = { name: string };

/**
 * Ports common/Tags.svelte (with TagList/TagItem): removable tag chips plus a
 * free-text input that suggests existing tags. Enter or Space adds what is
 * typed; adding a tag already present (case-insensitively) just clears the
 * input. Controlled -- the parent owns `tags` and hears `onAdd`/`onDelete`.
 *
 * The suggestion list is a Radix Popover anchored to the input, replacing the
 * Svelte version's hand-positioned `position: fixed` element appended to
 * <body> (which recomputes its own coordinates on scroll and resize). The
 * popover does that itself and stays inside a Dialog's focus trap, which a
 * body-level portal would not.
 */
export function Tags({
	tags,
	suggestionTags = [],
	disabled = false,
	onAdd,
	onDelete
}: {
	tags: Tag[];
	suggestionTags?: Array<Tag | string | null | undefined>;
	disabled?: boolean;
	onAdd: (name: string) => void;
	onDelete: (name: string) => void;
}) {
	const [value, setValue] = useState('');
	const [open, setOpen] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);

	const existing = useMemo(() => new Set(tags.map((t) => t.name.toLowerCase())), [tags]);
	const suggestions = useMemo(
		() =>
			suggestionTags
				.map((tag) => (typeof tag === 'string' ? tag : (tag?.name ?? '')).trim())
				.filter(
					(name) =>
						name && !existing.has(name.toLowerCase()) && name.toLowerCase().includes(value.trim().toLowerCase())
				)
				.slice(0, 8),
		[suggestionTags, existing, value]
	);

	const add = (raw: string) => {
		const name = raw.trim();
		if (name !== '') {
			if (!existing.has(name.toLowerCase())) onAdd(name);
			setValue('');
		}
		setOpen(false);
	};

	return (
		<div className="flex w-full flex-wrap items-center gap-1">
			{tags.map((tag) =>
				disabled ? (
					<span
						key={tag.name}
						className="bg-muted/50 text-muted-foreground flex items-center rounded-full border px-1.5 py-px text-xs"
					>
						<span className="line-clamp-1">{tag.name}</span>
					</span>
				) : (
					<button
						key={tag.name}
						type="button"
						className="bg-muted/50 text-muted-foreground hover:bg-muted flex items-center gap-1 rounded-full border px-1.5 py-px text-xs transition-colors"
						onClick={() => onDelete(tag.name)}
					>
						<span className="line-clamp-1">{tag.name}</span>
						<X className="size-3" strokeWidth={2.5} aria-label={`Remove tag ${tag.name}`} />
					</button>
				)
			)}

			{!disabled && (
				<Popover open={open && suggestions.length > 0} onOpenChange={setOpen}>
					<PopoverAnchor asChild>
						<div className="min-w-24 flex-1">
							<input
								ref={inputRef}
								value={value}
								className={cn(
									'placeholder:text-muted-foreground w-full bg-transparent text-xs outline-hidden',
									tags.length > 0 && 'px-0.5'
								)}
								placeholder="Add a tag..."
								role="combobox"
								aria-label="Add a tag"
								aria-autocomplete="list"
								aria-expanded={open && suggestions.length > 0}
								autoComplete="off"
								onFocus={() => setOpen(true)}
								onChange={(e) => {
									setValue(e.target.value);
									setOpen(true);
								}}
								onKeyDown={(e) => {
									if (e.key === 'Enter' || e.key === ' ') {
										e.preventDefault();
										add(value);
									} else if (e.key === 'Escape') {
										setOpen(false);
									}
								}}
							/>
						</div>
					</PopoverAnchor>
					<PopoverContent
						align="start"
						className="w-48 p-0.5"
						// Keep focus in the input: the popover is a suggestion list, not a dialog.
						onOpenAutoFocus={(e) => e.preventDefault()}
						onInteractOutside={(e) => {
							if (inputRef.current?.contains(e.target as Node)) e.preventDefault();
						}}
					>
						<div role="listbox" className="max-h-48 overflow-y-auto">
							{suggestions.map((name) => (
								<button
									key={name}
									type="button"
									role="option"
									aria-selected={false}
									className="hover:bg-muted flex w-full items-center rounded-xl px-2 py-1 text-left text-xs transition-colors"
									// mousedown would blur the input before the click lands.
									onMouseDown={(e) => e.preventDefault()}
									onClick={() => add(name)}
								>
									<span className="truncate">{name}</span>
								</button>
							))}
						</div>
					</PopoverContent>
				</Popover>
			)}
		</div>
	);
}
