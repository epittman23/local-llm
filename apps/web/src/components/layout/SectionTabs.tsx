import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, matchPath, useLocation } from 'react-router';
import { cn } from '@/lib/utils';

export interface SectionTab {
	to: string;
	label: ReactNode;
	/** Overrides matching `to` against the address, for a tab whose link is not the path it stands for. */
	active?: boolean;
	/** Match `to` exactly rather than as a prefix (an index tab). */
	end?: boolean;
}

/** How far the edge fade reaches into the strip. */
const FADE = '1.5rem';

function maskFor(start: boolean, end: boolean): string | undefined {
	if (start && end)
		return `linear-gradient(to right, transparent, #000 ${FADE}, #000 calc(100% - ${FADE}), transparent)`;
	if (start) return `linear-gradient(to right, transparent, #000 ${FADE})`;
	if (end) return `linear-gradient(to right, #000 calc(100% - ${FADE}), transparent)`;
	return undefined;
}

/**
 * The tab strip under a section's page header (Workspace, Admin, Benchmarks,
 * Playground). Each tab is a link to its own address, marked
 * `aria-current="page"` when open (NAV-1, NAV-2).
 *
 * LAY-4: a strip wider than the screen scrolls sideways, fades out at each
 * edge only while tabs are hidden past it, and keeps the open tab in view.
 * LAY-3: a tab is at least 24 px tall with a pointer and 44 px on touch.
 */
export function SectionTabs({ label, tabs, className }: { label: string; tabs: SectionTab[]; className?: string }) {
	const { pathname } = useLocation();
	const strip = useRef<HTMLElement>(null);
	const [fade, setFade] = useState({ start: false, end: false });
	const isActive = (tab: SectionTab) =>
		tab.active ?? matchPath({ path: tab.to, end: tab.end ?? false }, pathname) !== null;
	const activeTo = tabs.find(isActive)?.to;

	const measure = useCallback(() => {
		const el = strip.current;
		if (!el) return;
		const start = el.scrollLeft > 1;
		const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
		setFade((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
	}, []);

	/** Scrolls the open tab into view, then updates the fades. */
	const reveal = useCallback(() => {
		strip.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView?.({
			inline: 'nearest',
			block: 'nearest'
		});
		measure();
	}, [measure]);

	// The open tab comes into view on arrival and whenever another tab opens.
	useLayoutEffect(() => {
		if (activeTo !== undefined) reveal();
		else measure();
	}, [activeTo, reveal, measure]);

	// ...and again when the strip or a tab changes size (a count arriving
	// widens its tab), which would otherwise leave the open tab part hidden.
	useEffect(() => {
		const el = strip.current;
		if (!el || tabs.length === 0 || typeof ResizeObserver === 'undefined') return;
		const observer = new ResizeObserver(reveal);
		observer.observe(el);
		for (const tab of Array.from(el.children)) observer.observe(tab);
		return () => observer.disconnect();
	}, [reveal, tabs.length]);

	return (
		<nav
			ref={strip}
			aria-label={label}
			onScroll={measure}
			data-fade-start={fade.start || undefined}
			data-fade-end={fade.end || undefined}
			style={{ maskImage: maskFor(fade.start, fade.end) }}
			className={cn('flex min-w-0 gap-4 overflow-x-auto', className)}
		>
			{tabs.map((tab) => {
				const active = isActive(tab);
				return (
					<Link
						key={tab.to}
						to={tab.to}
						aria-current={active ? 'page' : undefined}
						className={cn(
							'text-body inline-flex min-h-6 shrink-0 items-center gap-1.5 border-b-2 px-1 pt-1 pb-2 whitespace-nowrap transition-colors select-none pointer-coarse:min-h-11',
							active
								? 'border-foreground text-foreground font-strong'
								: 'text-muted-foreground hover:text-foreground border-transparent'
						)}
					>
						{tab.label}
					</Link>
				);
			})}
		</nav>
	);
}

/**
 * A section layout's placeholder while its access check is pending (STA-2):
 * the shape of the page header and tab strip, never a bare "Loading…".
 */
export function SectionSkeleton({ label }: { label: string }) {
	return (
		<div aria-busy="true" className="flex flex-col gap-3 border-b px-4 pt-4 pb-3">
			<p className="sr-only" role="status">
				Loading {label}
			</p>
			<div className="bg-surface-3 h-7 w-40 animate-pulse rounded" />
			<div className="bg-surface-3 h-4 w-72 max-w-full animate-pulse rounded" />
			<div className="flex gap-4 pt-2">
				{[64, 80, 56].map((width) => (
					<div key={width} className="bg-surface-3 h-4 animate-pulse rounded" style={{ width }} />
				))}
			</div>
		</div>
	);
}
