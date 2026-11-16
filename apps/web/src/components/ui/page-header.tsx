import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';

/**
 * LAY-5: every page opens with its name, one sentence on what it is for, and its primary action.
 * A page that lists things may show how many there are as a secondary badge after the name
 * (`count`, the whole count, not what a filter leaves); its noun is read with the figure.
 */
export function PageHeader({
	title,
	description,
	action,
	count,
	as: Heading = 'h1'
}: {
	title: string;
	description: string;
	action?: ReactNode;
	/** The number of things the page lists, and what they are ('automations'). Left out while it loads. */
	count?: { value: number; noun: string };
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
				<div className="flex min-w-0 items-center gap-2">
					<Heading className="text-heading font-title tracking-tight">{title}</Heading>
					{count && (
						<Badge variant="secondary" className="tabular-nums">
							{count.value.toLocaleString()}
							<span className="sr-only"> {count.noun}</span>
						</Badge>
					)}
				</div>
				<p className="text-foreground-muted mt-1 max-w-[72ch]">{description}</p>
			</div>
			{action}
		</div>
	);
}
