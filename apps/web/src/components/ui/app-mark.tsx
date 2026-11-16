import { cn } from '@/lib/utils';

const SIZES = { 20: 'size-5', 24: 'size-6', 32: 'size-8' } as const;

/**
 * The mark's three shapes. public/favicon.svg, apps/desktop/static/mark.svg
 * and layouts/Base.astro's static splash draw the same paths, and
 * app-mark.test.tsx fails if any of them drifts.
 */
export const MARK_PATHS = {
	/** A squircle: one cubic per quadrant, within 0.06 units of an n=5 superellipse. */
	tile: 'M16 0C31.9 0 32 .1 32 16S31.9 32 16 32 0 31.9 0 16 .1 0 16 0Z',
	/** The ll of local-llm, each with the tail that keeps it from reading as I or 1. */
	letters: 'M9 7V23a2 2 0 0 0 2 2M15 7V23a2 2 0 0 0 2 2'
} as const;

/** The block cursor after the letters: a model writing its answer. */
export const MARK_CURSOR = { x: 20, y: 18, width: 4, height: 8, rx: 1 } as const;

/**
 * local-llm's mark (WRD-3): the ll of the name in `--foreground-strong`
 * followed by a block cursor in `--brand`, on a `--surface-1` squircle.
 * Strokes are 2 units on whole-unit centres, so they land on the pixel grid
 * at 16 and 32 px. Shown beside the name in the sidebar header, the phone bar
 * and the boot splash. Decorative unless given a `label`.
 */
export function AppMark({
	size = 24,
	label,
	className
}: {
	size?: keyof typeof SIZES;
	/** The mark's accessible name, when it stands in for the product's name. */
	label?: string;
	className?: string;
}) {
	return (
		<svg
			data-slot="app-mark"
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 32 32"
			className={cn('shrink-0', SIZES[size], className)}
			{...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
		>
			<path d={MARK_PATHS.tile} className="fill-surface-1" />
			<path
				d={MARK_PATHS.letters}
				fill="none"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
				className="stroke-foreground-strong"
			/>
			<rect {...MARK_CURSOR} className="fill-brand" />
		</svg>
	);
}
