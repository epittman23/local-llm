import { CircleAlertIcon, CircleCheckIcon, LoaderCircleIcon, TriangleAlertIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type StatusTone = 'success' | 'warning' | 'danger' | 'pending';

const ICONS = {
	success: CircleCheckIcon,
	warning: TriangleAlertIcon,
	danger: CircleAlertIcon,
	pending: LoaderCircleIcon
} as const;
const TONE_TEXT = {
	success: 'text-success',
	warning: 'text-warning',
	danger: 'text-danger',
	pending: 'text-foreground-muted'
} as const;

/**
 * The state of a whole section (STA-4, COL-3, FBK-4): a status icon and a
 * title in its status colour, then what it means and what to do in plain
 * words, an action ("Check again"), and the server's own words behind
 * "Details". It is not help text: it sits on its own surface, at the top of
 * the section it describes. It is a live `status` region, not an `alert`, so
 * a page that opens on a known problem does not interrupt a screen reader.
 *
 * A status is never colour alone: the title says it, and the icon repeats it.
 */
export function StatusNotice({
	tone,
	title,
	children,
	action,
	details,
	className
}: {
	tone: StatusTone;
	title: string;
	/** What it means and what to do, as sentences. */
	children?: ReactNode;
	/** One action that can change the state: "Check again". */
	action?: ReactNode;
	/** The technical words (the server's reason), behind "Details". */
	details?: string | null;
	className?: string;
}) {
	const Icon = ICONS[tone];
	return (
		<div
			data-slot="status-notice"
			data-tone={tone}
			role="status"
			className={cn('bg-surface-2 flex items-start gap-3 rounded-lg border px-3 py-2.5 text-body', className)}
		>
			<Icon aria-hidden className={cn('mt-0.5 size-4 shrink-0', TONE_TEXT[tone], tone === 'pending' && 'animate-spin')} />
			<div className="min-w-0 flex-1">
				<p className={cn('font-strong', TONE_TEXT[tone])}>{title}</p>
				{children && <div className="text-foreground mt-1 flex flex-col gap-1 text-dense">{children}</div>}
				{details && (
					<details className="text-foreground-muted mt-1.5 text-dense">
						<summary className="cursor-pointer">Details</summary>
						<p className="mt-1 break-words font-mono">{details}</p>
					</details>
				)}
				{action && <div className="mt-2 flex flex-wrap gap-2">{action}</div>}
			</div>
		</div>
	);
}
