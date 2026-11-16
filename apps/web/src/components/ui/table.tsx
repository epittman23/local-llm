import * as React from 'react';
import { SortHeaderButton } from '@/components/common/ListChrome';
import { cn } from '@/lib/utils';

/**
 * DAT-6: a table wider than its frame scrolls inside it, and a shadow on each
 * edge that hides columns says so. Give it `aria-label` (it is moved to the
 * scrolling container, which becomes a named region) so the region can be
 * reached and scrolled from the keyboard once it overflows (A11Y-2).
 * `stickyFirstColumn` keeps the first column in view while the rest scrolls:
 * its cells are opaque in the page colour, or in `--table-surface` where the
 * table sits on another surface (set it on the table or a parent), and take
 * the row's hover tint.
 */
function Table({
	className,
	'aria-label': ariaLabel,
	stickyFirstColumn = false,
	...props
}: React.ComponentProps<'table'> & { stickyFirstColumn?: boolean }) {
	const scroller = React.useRef<HTMLDivElement>(null);
	const [clipped, setClipped] = React.useState({ start: false, end: false });

	React.useEffect(() => {
		const el = scroller.current;
		if (!el) return;
		const measure = () => {
			const start = el.scrollLeft > 0;
			const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
			setClipped((was) => (was.start === start && was.end === end ? was : { start, end }));
		};
		measure();
		el.addEventListener('scroll', measure, { passive: true });
		window.addEventListener('resize', measure);
		// The table grows when its rows arrive; happy-dom and old engines have no ResizeObserver.
		const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
		observer?.observe(el);
		if (el.firstElementChild) observer?.observe(el.firstElementChild);
		return () => {
			el.removeEventListener('scroll', measure);
			window.removeEventListener('resize', measure);
			observer?.disconnect();
		};
	}, []);

	const overflows = clipped.start || clipped.end;
	return (
		<div
			data-slot="table-frame"
			data-clipped-start={clipped.start || undefined}
			data-clipped-end={clipped.end || undefined}
			className="relative w-full before:pointer-events-none before:absolute before:inset-y-0 before:left-0 before:z-10 before:w-4 before:bg-linear-to-r before:from-scrim before:to-transparent before:opacity-0 before:transition-opacity after:pointer-events-none after:absolute after:inset-y-0 after:right-0 after:z-10 after:w-4 after:bg-linear-to-l after:from-scrim after:to-transparent after:opacity-0 after:transition-opacity data-clipped-start:before:opacity-100 data-clipped-end:after:opacity-100"
		>
			<div
				ref={scroller}
				data-slot="table-container"
				role={ariaLabel ? 'region' : undefined}
				aria-label={ariaLabel}
				tabIndex={ariaLabel && overflows ? 0 : undefined}
				className="relative w-full overflow-x-auto"
			>
				<table
					data-slot="table"
					data-sticky-first-column={stickyFirstColumn || undefined}
					className={cn(
						'w-full caption-bottom text-sm',
						stickyFirstColumn &&
							'[&_tr>:first-child]:sticky [&_tr>:first-child]:left-0 [&_tr>:first-child]:z-[1] [&_tr>:first-child]:bg-[var(--table-surface,var(--page))] [@media(hover:hover)]:[&_tr:hover>:first-child]:bg-[color-mix(in_srgb,var(--muted)_50%,var(--table-surface,var(--page)))]',
						className
					)}
					{...props}
				/>
			</div>
		</div>
	);
}

function TableHeader({ className, ...props }: React.ComponentProps<'thead'>) {
	return <thead data-slot="table-header" className={cn('[&_tr]:border-b', className)} {...props} />;
}

function TableBody({ className, ...props }: React.ComponentProps<'tbody'>) {
	return <tbody data-slot="table-body" className={cn('[&_tr:last-child]:border-0', className)} {...props} />;
}

function TableFooter({ className, ...props }: React.ComponentProps<'tfoot'>) {
	return (
		<tfoot
			data-slot="table-footer"
			className={cn('border-t bg-muted/50 font-medium [&>tr]:last:border-b-0', className)}
			{...props}
		/>
	);
}

/** Whether a click on a row is the row's own: not on a control in it, nor in a menu it renders through a portal. */
function isRowClick(event: React.MouseEvent<HTMLElement>) {
	const target = event.target as Element;
	return event.currentTarget.contains(target) && !target.closest('button, a, input, select, textarea, [role="menuitem"]');
}

/**
 * A row. With `onOpen` it is a row that opens something (DAT-6, NAV-5): a
 * click anywhere on it opens it, except on a control in it, and its name
 * cell holds a button calling the same `onOpen`, which is how the keyboard
 * reaches it (Tab, then Enter).
 */
function TableRow({
	className,
	onOpen,
	onClick,
	...props
}: React.ComponentProps<'tr'> & {
	/** Opens what the row stands for. */
	onOpen?: () => void;
}) {
	return (
		<tr
			data-slot="table-row"
			data-opens={onOpen ? '' : undefined}
			className={cn(
				'border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted',
				onOpen && 'cursor-pointer',
				className
			)}
			onClick={(event) => {
				onClick?.(event);
				if (onOpen && !event.defaultPrevented && isRowClick(event)) onOpen();
			}}
			{...props}
		/>
	);
}

function TableHead({ className, ...props }: React.ComponentProps<'th'>) {
	return (
		<th
			data-slot="table-head"
			className={cn(
				'h-10 px-2 text-left align-middle font-medium whitespace-nowrap text-foreground [&:has([role=checkbox])]:pr-0',
				className
			)}
			{...props}
		/>
	);
}

/**
 * A column heading that sorts the table (DAT-6): the shared sort button, and
 * `aria-sort` on the open sort's heading only, so a screen reader hears which
 * column orders the rows and which way.
 */
function TableSortHead({
	label,
	active,
	direction,
	onSort,
	buttonClassName,
	...props
}: Omit<React.ComponentProps<'th'>, 'children'> & {
	label: string;
	/** This column is the sort. */
	active: boolean;
	direction: 'asc' | 'desc';
	onSort: () => void;
	buttonClassName?: string;
}) {
	return (
		<TableHead
			scope="col"
			aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : undefined}
			{...props}
		>
			<SortHeaderButton
				label={label}
				active={active}
				direction={direction}
				onClick={onSort}
				className={cn('-mx-2', buttonClassName)}
			/>
		</TableHead>
	);
}

function TableCell({ className, ...props }: React.ComponentProps<'td'>) {
	return (
		<td
			data-slot="table-cell"
			className={cn('p-2 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0', className)}
			{...props}
		/>
	);
}

function TableCaption({ className, ...props }: React.ComponentProps<'caption'>) {
	return (
		<caption data-slot="table-caption" className={cn('mt-4 text-sm text-muted-foreground', className)} {...props} />
	);
}

export {
	Table,
	TableHeader,
	TableBody,
	TableFooter,
	TableHead,
	TableSortHead,
	TableRow,
	TableCell,
	TableCaption
};
