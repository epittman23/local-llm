import { csvCell } from '@/lib/utils/csv';

type FeedbackRow = {
	id: string;
	user_id?: string;
	created_at?: number;
	updated_at?: number;
	data?: { chat_id?: string; model_id?: string; sibling_model_ids?: string[]; rating?: unknown; reason?: string; comment?: string } | null;
};

/**
 * The flat CSV of Feedbacks.svelte's "Export as CSV": one row per feedback with
 * the nested `data` object spread into columns (sibling model ids joined by
 * `;`). Quoting and formula-neutralizing are csvCell's (a comment of `=1+1` is
 * written as text, not left to be run by the spreadsheet). Empty input gives an
 * empty string, not a bare header.
 */
export function feedbacksToCsv(feedbacks: FeedbackRow[]): string {
	const rows = feedbacks.map((f) => ({
		id: f.id,
		user_id: f.user_id,
		chat_id: f.data?.chat_id ?? '',
		model_id: f.data?.model_id ?? '',
		sibling_model_ids: (f.data?.sibling_model_ids ?? []).join(';'),
		rating: f.data?.rating ?? '',
		reason: f.data?.reason ?? '',
		comment: f.data?.comment ?? '',
		created_at: f.created_at,
		updated_at: f.updated_at
	}));
	if (rows.length === 0) return '';
	const headers = Object.keys(rows[0]);
	return [headers.join(','), ...rows.map((r) => headers.map((h) => csvCell(r[h as keyof typeof r])).join(','))].join('\n');
}

/** "won" / "draw" / "lost" for a stored rating (1 / 0 / -1, number or string), or null when unset. */
export function ratingOutcome(rating: unknown): 'won' | 'draw' | 'lost' | null {
	switch (String(rating ?? '')) {
		case '1':
			return 'won';
		case '0':
			return 'draw';
		case '-1':
			return 'lost';
		default:
			return null;
	}
}
