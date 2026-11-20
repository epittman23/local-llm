import { CircleCheckIcon, CircleXIcon, type LucideIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

type Outcome = { label: string; variant: 'success' | 'danger' | 'secondary'; icon?: LucideIcon };

/**
 * The six outcomes a graded item can have (the `benchmark_result` outcome
 * check constraint), each with one word and one colour on every page
 * (DAT-3, COL-3): a pass is success, every way of failing is danger, and an
 * item nobody attempted is neutral.
 */
export const OUTCOMES: Record<string, Outcome> = {
	pass: { label: 'passed', variant: 'success', icon: CircleCheckIcon },
	fail_assert: { label: 'assert failed', variant: 'danger', icon: CircleXIcon },
	fail_error: { label: 'error', variant: 'danger', icon: CircleXIcon },
	fail_timeout: { label: 'timed out', variant: 'danger', icon: CircleXIcon },
	no_code: { label: 'no code', variant: 'danger', icon: CircleXIcon },
	skipped: { label: 'skipped', variant: 'secondary' }
};

/** What an outcome reads as, for text that is not a badge ("3 assert failed"). */
export const outcomeLabel = (outcome: string): string => OUTCOMES[outcome]?.label ?? outcome;

/** A graded item's outcome as a status badge. An outcome this page does not know shows its own word, neutral. */
export function OutcomeBadge({ outcome, className }: { outcome: string; className?: string }) {
	const known = OUTCOMES[outcome];
	const Icon = known?.icon;
	return (
		<Badge variant={known?.variant ?? 'secondary'} data-outcome={outcome} className={className}>
			{Icon && <Icon aria-hidden data-icon="inline-start" />}
			{known?.label ?? outcome}
		</Badge>
	);
}
