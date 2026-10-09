import { type History, type Message, messagesList } from './history';

// The rating a reply is given (ResponseMessage.svelte's feedbackHandler and
// RateComment.svelte): thumbs up/down, then optional reason, 1-10 score,
// comment and tags, all stored on the message's `annotation` and sent to the
// evaluations API as one feedback item.

export const LIKE_REASONS = [
	'accurate_information',
	'followed_instructions_perfectly',
	'showcased_creativity',
	'positive_attitude',
	'attention_to_detail',
	'thorough_explanation',
	'other'
] as const;
export const DISLIKE_REASONS = [
	'dont_like_the_style',
	'too_verbose',
	'not_helpful',
	'not_factually_correct',
	'didnt_fully_follow_instructions',
	'refused_when_it_shouldnt_have',
	'being_lazy',
	'other'
] as const;
export const REASON_LABELS: Record<string, string> = {
	accurate_information: 'Accurate information',
	followed_instructions_perfectly: 'Followed instructions perfectly',
	showcased_creativity: 'Showcased creativity',
	positive_attitude: 'Positive attitude',
	attention_to_detail: 'Attention to detail',
	thorough_explanation: 'Thorough explanation',
	dont_like_the_style: "Don't like the style",
	too_verbose: 'Too verbose',
	not_helpful: 'Not helpful',
	not_factually_correct: 'Not factually correct',
	didnt_fully_follow_instructions: "Didn't fully follow instructions",
	refused_when_it_shouldnt_have: "Refused when it shouldn't have",
	being_lazy: 'Being lazy',
	other: 'Other'
};

export type FeedbackDetails = {
	reason?: string;
	comment?: string;
	tags?: string[];
	details?: { rating: number | null };
};

/** The message's annotation after a rating and/or details. */
export const annotate = (m: Message, rating: number | null, details: FeedbackDetails | null = null) => ({
	...(m.annotation ?? {}),
	...(rating !== null ? { rating } : {}),
	...(details ?? {})
});

/**
 * The feedback item for the evaluations API. `sibling_model_ids` (other
 * replies to the same prompt) is what makes a rating count in the arena
 * leaderboard; `base_models` maps each model to the model it wraps.
 */
export function feedbackItem(opts: {
	history: History;
	message: Message;
	annotation: Record<string, unknown>;
	chatId: string;
	chat: unknown;
	baseModelOf: (id: string) => string | null | undefined;
}) {
	const { history, message } = opts;
	const siblings = (message.parentId ? history.messages[message.parentId]?.childrenIds : []) ?? [];
	const modelOf = (m: Message | undefined) => m?.selectedModelId ?? m?.model ?? '';
	const siblingModels =
		siblings.length > 1
			? siblings.filter((id) => id !== message.id).map((id) => modelOf(history.messages[id]))
			: undefined;
	const modelId = modelOf(message);
	const base: Record<string, string | null> = {};
	for (const id of [modelId, ...(siblingModels ?? [])]) {
		const b = opts.baseModelOf(id);
		if (b !== undefined) base[id] = b;
	}
	return {
		type: 'rating',
		data: { ...opts.annotation, model_id: modelId, ...(siblingModels ? { sibling_model_ids: siblingModels } : {}) },
		meta: {
			arena: message.arena ?? false,
			model_id: message.model,
			message_id: message.id,
			message_index: messagesList(history, message.id).length,
			chat_id: opts.chatId,
			base_models: base
		},
		snapshot: { chat: opts.chat }
	};
}
