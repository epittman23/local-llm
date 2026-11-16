import { ThumbsDown, ThumbsUp } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { FeedbackItem } from './FeedbackModal';
import { ratingOutcome } from './feedbackCsv';

/**
 * What a rating says (#1027): a thumb on one model's reply is "Up" or "Down";
 * an arena comparison, where the model was chosen over others, is "Won",
 * "Lost" or "Draw". Null when the rating is unset.
 */
export function feedbackResult(feedback: Pick<FeedbackItem, 'data'>): 'Up' | 'Down' | 'Won' | 'Lost' | 'Draw' | null {
	const outcome = ratingOutcome(feedback.data?.rating);
	if (!outcome) return null;
	if (feedback.data?.sibling_model_ids?.length) return outcome === 'won' ? 'Won' : outcome === 'lost' ? 'Lost' : 'Draw';
	return outcome === 'won' ? 'Up' : outcome === 'lost' ? 'Down' : null;
}

/** The result as a neutral badge: a thumb's direction has an icon, so it is never colour alone (DAT-3). */
export function ResultBadge({ result }: { result: ReturnType<typeof feedbackResult> }) {
	if (!result) return <span className="text-foreground-muted">–</span>;
	const Icon = result === 'Up' ? ThumbsUp : result === 'Down' ? ThumbsDown : null;
	return (
		<Badge variant="secondary">
			{Icon && <Icon aria-hidden data-icon="inline-start" />}
			{result}
		</Badge>
	);
}
