import { CircleCheck, CircleX } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

/** A run's status (COL-3, DAT-3): the same word, colour and icon on the list and the automation's page. */
export function RunBadge({ status }: { status: 'success' | 'error' }) {
	return status === 'success' ? (
		<Badge variant="success">
			<CircleCheck data-icon="inline-start" aria-hidden />
			Succeeded
		</Badge>
	) : (
		<Badge variant="danger">
			<CircleX data-icon="inline-start" aria-hidden />
			Failed
		</Badge>
	);
}
