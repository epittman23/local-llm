import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { Children, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * The search box + filter cluster every workspace list opens with (the same
 * markup is repeated verbatim in Prompts/Skills/Knowledge/Models/Tools.svelte).
 * `children` is the right-hand cluster: view selector, tag selector, ...
 */
export function ListSearchBar({
	value,
	onChange,
	placeholder,
	children
}: {
	value: string;
	onChange: (value: string) => void;
	placeholder: string;
	children?: ReactNode;
}) {
	return (
		<div className="flex w-full flex-wrap items-center gap-2">
			{/* FRM-1, A11Y-1: the box is the field (edge, fill, focus outline); the input inside is bare. */}
			<div
				data-composite-field
				className="border-border-control bg-surface-1 flex h-(--control) min-w-48 flex-1 items-center gap-2 rounded-lg border ps-2.5 pe-1 pointer-coarse:h-(--control-touch)"
			>
				<Search aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
				<input
					className="text-body h-full w-full min-w-0 bg-transparent"
					value={value}
					onChange={(e) => onChange(e.target.value)}
					aria-label={placeholder}
					placeholder={placeholder}
				/>
				{value && (
					<Button variant="ghost" size="icon-xs" type="button" aria-label="Clear search" onClick={() => onChange('')}>
						<X className="size-3" strokeWidth={2} />
					</Button>
				)}
			</div>
			{/* A list whose filters are all hidden (one account, no tags) gives the search the whole row. */}
			{Children.toArray(children).length > 0 && (
				<div className="flex max-w-full shrink-0 overflow-x-auto sm:max-w-[55%]">
					<div className="flex w-fit gap-0.5 whitespace-nowrap">{children}</div>
				</div>
			)}
		</div>
	);
}

/** A sortable column header: label plus an arrow when it is the active sort. */
export function SortHeaderButton({
	label,
	active,
	direction,
	onClick,
	className
}: {
	label: string;
	active: boolean;
	direction: 'asc' | 'desc';
	onClick: () => void;
	className: string;
}) {
	return (
		<Button variant="ghost" size="sm" className={cn('justify-start', className)} type="button" onClick={onClick}>
			{label}
			{active && (direction === 'asc' ? <ChevronUp className="size-2" /> : <ChevronDown className="size-2" />)}
		</Button>
	);
}

/**
 * STA-3: an empty list says one of two things. With nothing searched or
 * filtered, what belongs here and the first step (`action`); with a search or
 * a filter, that nothing matches it, naming the search, and a way to clear it.
 */
export function ListEmptyState({
	title,
	description,
	action,
	query = '',
	filtered = false,
	onClear
}: {
	/** The fresh-install heading: "No models yet". */
	title: string;
	/** One line saying what a thing in this list is. */
	description?: string;
	/** The first step, usually the section's New button. */
	action?: ReactNode;
	/** The search as typed. */
	query?: string;
	/** Whether a filter other than the search narrows the list. */
	filtered?: boolean;
	/** Clears the search and the filters. */
	onClear?: () => void;
}) {
	const searched = query.trim() !== '';
	const narrowed = searched || filtered;
	return (
		<div className="flex w-full flex-col items-center justify-center py-16 pb-24">
			<div className="flex max-w-sm flex-col items-center gap-3 text-center">
				<div className="flex flex-col gap-1">
					<h2 className="text-body font-medium">
						{narrowed ? (searched ? `Nothing matches “${query.trim()}”` : 'Nothing matches these filters') : title}
					</h2>
					{!narrowed && description && <p className="text-muted-foreground text-body">{description}</p>}
				</div>
				{narrowed
					? onClear && (
							<Button variant="outline" size="sm" type="button" onClick={onClear}>
								{searched ? 'Clear search' : 'Clear filters'}
							</Button>
						)
					: action}
			</div>
		</div>
	);
}

/** DAT-2: while a search or filter narrows a list, how many of the whole it shows. */
export function ListMatchCount({ shown, total, noun }: { shown: number; total: number | null; noun: string }) {
	return (
		<p role="status" className="text-muted-foreground text-caption px-1.5 tabular-nums">
			{total === null ? `${shown} ${noun}` : `${shown} of ${total} ${noun}`}
		</p>
	);
}
