import type { ReactNode } from 'react';

/** LAY-5: every page opens with its name, one sentence on what it is for, and its primary action. */
export function PageHeader({
	title,
	description,
	action,
	as: Heading = 'h1'
}: {
	title: string;
	description: string;
	action?: ReactNode;
	/** `h1` on a real page. Lower only where the header is nested inside another page, as on /ui. */
	as?: 'h1' | 'h2' | 'h3' | 'h4';
}) {
	return (
		// A page's own header: on a phone, toasts and the connection banner start below it (FBK-2).
		<div
			data-page-top={Heading === 'h1' ? '' : undefined}
			className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3"
		>
			<div className="min-w-0">
				<Heading className="text-heading font-title tracking-tight">{title}</Heading>
				<p className="text-foreground-muted mt-1 max-w-[72ch]">{description}</p>
			</div>
			{action}
		</div>
	);
}
