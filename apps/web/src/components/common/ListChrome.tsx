import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import type { ReactNode } from 'react';

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
		<div className="flex h-8 w-full items-center gap-2">
			<div className="flex min-w-0 flex-1 items-center">
				<Search className="text-muted-foreground mr-3 ml-1 size-3.5" />
				<input
					className="w-full rounded-r-xl bg-transparent py-1 pr-4 text-sm outline-hidden"
					value={value}
					onChange={(e) => onChange(e.target.value)}
					aria-label={placeholder}
					placeholder={placeholder}
				/>
				{value && (
					<button
						type="button"
						className="hover:bg-muted rounded-full p-0.5 transition"
						aria-label="Clear search"
						onClick={() => onChange('')}
					>
						<X className="size-3" strokeWidth={2} />
					</button>
				)}
			</div>
			<div className="flex max-w-[55%] shrink-0 overflow-x-auto">
				<div className="flex w-fit gap-0.5 whitespace-nowrap">{children}</div>
			</div>
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
		<button type="button" className={className} onClick={onClick}>
			{label}
			{active && (direction === 'asc' ? <ChevronUp className="size-2" /> : <ChevronDown className="size-2" />)}
		</button>
	);
}

export function ListEmptyState({ title }: { title: string }) {
	return (
		<div className="flex w-full flex-col items-center justify-center py-16 pb-24">
			<div className="max-w-sm text-center">
				<div className="mb-1.5 text-sm">{title}</div>
				<div className="text-muted-foreground text-center text-xs leading-5">
					Try adjusting your search or filter to find what you are looking for.
				</div>
			</div>
		</div>
	);
}

/** A click on a control inside a clickable row belongs to the control, not the row. */
export const isControlClick = (target: EventTarget | null) =>
	target instanceof Element && !!target.closest('button, a, input, [role="menu"]');
