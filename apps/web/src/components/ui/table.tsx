import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * DAT-6: a table wider than its frame scrolls inside it, and a shadow on each
 * edge that hides columns says so. Give it `aria-label` (it is moved to the
 * scrolling container, which becomes a named region) so the region can be
 * reached and scrolled from the keyboard once it overflows (A11Y-2).
 * `stickyFirstColumn` keeps the first column in view while the rest scrolls.
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
							'[&_tr>:first-child]:sticky [&_tr>:first-child]:left-0 [&_tr>:first-child]:z-[1] [&_tr>:first-child]:bg-[var(--table-surface,var(--page))]',
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

function TableRow({ className, ...props }: React.ComponentProps<'tr'>) {
	return (
		<tr
			data-slot="table-row"
			className={cn(
				'border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted',
				className
			)}
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

export { Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell, TableCaption };
