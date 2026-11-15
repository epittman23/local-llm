import { cn } from '@/lib/utils';

const SIZES = { 20: 'size-5', 24: 'size-6', 32: 'size-8' } as const;

/**
 * local-llm's mark (WRD-3): public/favicon.svg's shape drawn with the theme's
 * tokens, lucide's Sigma glyph in the brand colour on a `--surface-1`
 * rounded square. Shown beside the name in the sidebar header, the phone bar
 * and the boot splash; layouts/Base.astro's static splash repeats the same
 * SVG. Decorative unless given a `label`.
 *
 * The glyph is lucide's Sigma (ISC licence; copyright (c) for portions of
 * Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT); all other
 * copyright (c) for Lucide are held by Lucide Contributors 2022).
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
			<rect width="32" height="32" rx="7" className="fill-surface-1" />
			<path
				transform="translate(4 4)"
				d="M18 7V5a1 1 0 0 0-1-1H6.5a.5.5 0 0 0-.4.8l4.5 6a2 2 0 0 1 0 2.4l-4.5 6a.5.5 0 0 0 .4.8H17a1 1 0 0 0 1-1v-2"
				fill="none"
				strokeWidth="2.25"
				strokeLinecap="round"
				strokeLinejoin="round"
				className="stroke-brand"
			/>
		</svg>
	);
}
