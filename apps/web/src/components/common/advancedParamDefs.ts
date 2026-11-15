// The parameter table behind <AdvancedParams>. The Svelte component
// (chat/Settings/Advanced/AdvancedParams.svelte, 1,465 lines) spells out each of
// these ~30 controls by hand; nearly all follow one pattern -- a "Default /
// Custom" toggle that, when on Custom, shows a control seeded with a starting
// value -- so here they are rows in a table and one renderer handles them all.
// The seeds and ranges are copied from that component. Each row is named as a
// person would name it, with its API name (`key`) shown beside it, and has one
// sentence of help (WRD-2, #996).

export type ParamDef = {
	/** The API name, sent with the request. */
	key: string;
	/** What the person reads (WRD-2). */
	label: string;
	/** One sentence, shown under the row. */
	help: string;
	/** `common`: the first, always-open group; `ollama`: only used by Ollama models; otherwise "More parameters". */
	group?: 'common' | 'ollama';
	/** Only shown to admins (server-side / Ollama-level settings). */
	admin?: boolean;
} & (
	| {
			kind: 'range';
			seed: number;
			min: number;
			max: number;
			step: number;
			numberStep?: number | 'any';
			numberMax?: number | null;
			integer?: boolean;
	  }
	| { kind: 'number'; seed: number; min: number; step: number; placeholder: string }
	| { kind: 'text'; seed: string; placeholder: string }
	| { kind: 'switch'; seed: boolean }
	| { kind: 'tri'; tri: 'stream_response' | 'function_calling' | 'think' | 'reasoning_tags' }
);

export const paramDefs: ParamDef[] = [
	{
		key: 'stream_response',
		label: 'Stream the reply',
		kind: 'tri',
		tri: 'stream_response',
		help: 'Show the reply as it is written instead of all at once.'
	},
	{
		key: 'stream_delta_chunk_size',
		label: 'Stream chunk size',
		admin: true,
		kind: 'range',
		seed: 1,
		min: 1,
		max: 128,
		step: 1,
		numberStep: 'any',
		numberMax: null,
		help: 'How much text is sent to the page at a time while a reply streams.'
	},
	{
		key: 'compact_token_threshold',
		label: 'Context compaction threshold',
		admin: true,
		kind: 'number',
		seed: 80000,
		min: 1,
		step: 1,
		placeholder: 'Enter token threshold',
		help: 'Compact the conversation past this many tokens, overriding the server-wide threshold up to its cap.'
	},
	{
		key: 'function_calling',
		label: 'Function calling',
		kind: 'tri',
		tri: 'function_calling',
		help: "Native uses the model's own tool calling; Legacy works with more models by prompting for tools."
	},
	{
		key: 'reasoning_tags',
		label: 'Reasoning tags',
		kind: 'tri',
		tri: 'reasoning_tags',
		help: "Which tags mark the model's reasoning: the usual ones, none, or your own."
	},
	{
		key: 'seed',
		group: 'common',
		label: 'Seed',
		kind: 'number',
		seed: 0,
		min: 0,
		step: 1,
		placeholder: 'Enter Seed',
		help: 'A fixed seed makes the same prompt give the same reply.'
	},
	{
		key: 'stop',
		label: 'Stop sequence',
		kind: 'text',
		seed: '',
		placeholder: 'Enter stop sequence',
		help: 'Text at which the model stops writing; separate several with commas.'
	},
	{
		key: 'temperature',
		group: 'common',
		label: 'Temperature',
		kind: 'range',
		seed: 0.8,
		min: 0,
		max: 2,
		step: 0.05,
		help: 'Higher values give more varied replies, lower values more focused ones.'
	},
	{
		key: 'reasoning_effort',
		group: 'common',
		label: 'Reasoning effort',
		kind: 'text',
		seed: 'medium',
		placeholder: 'Enter reasoning effort',
		help: 'How much a reasoning model thinks before it answers (low, medium or high), where the provider supports it.'
	},
	{
		key: 'logit_bias',
		label: 'Token bias',
		kind: 'text',
		seed: '',
		placeholder: 'Enter comma-separated "token:bias_value" pairs (example: 5432:100, 413:-100)',
		help: 'Make specific tokens more or less likely, as token:bias pairs from -100 to 100.'
	},
	{
		key: 'max_tokens',
		group: 'common',
		label: 'Max tokens',
		kind: 'range',
		seed: 128,
		min: -2,
		max: 131072,
		step: 1,
		numberStep: 1,
		numberMax: null,
		help: 'The longest reply the model may write, in tokens.'
	},
	{
		key: 'top_k',
		label: 'Top K',
		kind: 'range',
		seed: 40,
		min: 0,
		max: 1000,
		step: 1,
		numberStep: 1,
		integer: true,
		help: 'Sample only from the K most likely tokens; lower is more conservative.'
	},
	{
		key: 'top_p',
		label: 'Top P',
		kind: 'range',
		seed: 0.9,
		min: 0,
		max: 1,
		step: 0.05,
		help: 'Sample from the smallest set of tokens whose probabilities add up to P.'
	},
	{
		key: 'min_p',
		label: 'Min P',
		kind: 'range',
		seed: 0,
		min: 0,
		max: 1,
		step: 0.05,
		help: 'Drop tokens less likely than P times the most likely one.'
	},
	{
		key: 'frequency_penalty',
		label: 'Frequency penalty',
		kind: 'range',
		seed: 1.1,
		min: -2,
		max: 2,
		step: 0.05,
		help: 'Make a token less likely the more often it has appeared; 0 turns it off.'
	},
	{
		key: 'presence_penalty',
		label: 'Presence penalty',
		kind: 'range',
		seed: 0,
		min: -2,
		max: 2,
		step: 0.05,
		help: 'Make a token less likely once it has appeared at all; 0 turns it off.'
	},
	{
		key: 'mirostat',
		label: 'Mirostat',
		kind: 'range',
		seed: 0,
		min: 0,
		max: 2,
		step: 1,
		numberStep: 1,
		help: 'Sampling that steers toward a steady perplexity: 0 is off, 1 and 2 are its versions.'
	},
	{
		key: 'mirostat_eta',
		label: 'Mirostat learning rate',
		kind: 'range',
		seed: 0.1,
		min: 0,
		max: 1,
		step: 0.05,
		help: 'How quickly Mirostat reacts to the text written so far.'
	},
	{
		key: 'mirostat_tau',
		label: 'Mirostat target',
		kind: 'range',
		seed: 5,
		min: 0,
		max: 10,
		step: 0.5,
		help: 'Lower values give more focused, coherent text.'
	},
	{
		key: 'repeat_last_n',
		label: 'Repeat window',
		kind: 'range',
		seed: 64,
		min: -1,
		max: 128,
		step: 1,
		numberStep: 1,
		help: 'How many recent tokens the repeat penalty looks back over.'
	},
	{
		key: 'tfs_z',
		label: 'Tail-free sampling',
		kind: 'range',
		seed: 1,
		min: 0,
		max: 2,
		step: 0.05,
		help: 'Lowers the weight of unlikely tokens; 1 turns it off.'
	},
	{
		key: 'repeat_penalty',
		label: 'Repeat penalty',
		kind: 'range',
		seed: 1.1,
		min: -2,
		max: 2,
		step: 0.05,
		help: 'Make repeated runs of tokens less likely; 1 turns it off.'
	},
	{
		key: 'use_mmap',
		group: 'ollama',
		label: 'Memory-map the model',
		admin: true,
		kind: 'switch',
		seed: true,
		help: 'Load the model by mapping its file into memory.'
	},
	{
		key: 'use_mlock',
		group: 'ollama',
		label: 'Lock the model in memory',
		admin: true,
		kind: 'switch',
		seed: true,
		help: "Keep the model's memory from being swapped out to disk."
	},
	{
		key: 'think',
		group: 'ollama',
		label: 'Think',
		admin: true,
		kind: 'tri',
		tri: 'think',
		help: 'Let the model reason before it answers.'
	},
	{
		key: 'format',
		group: 'ollama',
		label: 'Response format',
		admin: true,
		kind: 'text',
		seed: 'json',
		placeholder: 'e.g. "json" or a JSON schema',
		help: 'json, or a JSON schema the reply must follow.'
	},
	{
		key: 'num_keep',
		group: 'ollama',
		label: 'Tokens kept',
		admin: true,
		kind: 'range',
		seed: 24,
		min: -1,
		max: 10240000,
		step: 1,
		numberStep: 1,
		numberMax: null,
		help: 'How many tokens are kept when the context is refreshed.'
	},
	{
		key: 'num_ctx',
		group: 'ollama',
		label: 'Context window',
		admin: true,
		kind: 'range',
		seed: 2048,
		min: -1,
		max: 10240000,
		step: 1,
		numberStep: 1,
		numberMax: null,
		help: 'The size of the context window, in tokens.'
	},
	{
		key: 'num_batch',
		group: 'ollama',
		label: 'Batch size',
		admin: true,
		kind: 'range',
		seed: 512,
		min: 256,
		max: 8192,
		step: 256,
		numberStep: 256,
		numberMax: null,
		help: 'How many tokens are processed together; larger is faster and uses more memory.'
	},
	{
		key: 'num_thread',
		group: 'ollama',
		label: 'CPU threads',
		admin: true,
		kind: 'range',
		seed: 2,
		min: 1,
		max: 256,
		step: 1,
		numberStep: 1,
		help: 'How many threads do the computation.'
	},
	{
		key: 'num_gpu',
		group: 'ollama',
		label: 'Layers on the GPU',
		admin: true,
		kind: 'range',
		seed: 0,
		min: 0,
		max: 256,
		step: 1,
		numberStep: 1,
		help: "How many of the model's layers are offloaded to the GPU."
	},
	{
		key: 'keep_alive',
		group: 'ollama',
		label: 'Keep loaded',
		admin: true,
		kind: 'text',
		seed: '5m',
		placeholder: "e.g. '30s','10m'. Valid time units are 's', 'm', 'h'.",
		help: 'How long the model stays loaded after a request, such as 5m.'
	}
];

export type Params = Record<string, any>;

/** `null`/`undefined` both mean "not overridden". */
export const isUnset = (value: unknown) => (value ?? null) === null;

/** The order of the Common group: what a math and coding user changes most. */
const COMMON_ORDER = ['temperature', 'max_tokens', 'reasoning_effort', 'seed'];

/** The rows of each group, in the order they are shown. */
export function paramGroups(defs: ParamDef[] = paramDefs) {
	return {
		common: defs
			.filter((d) => d.group === 'common')
			.sort((a, b) => COMMON_ORDER.indexOf(a.key) - COMMON_ORDER.indexOf(b.key)),
		more: defs.filter((d) => !d.group),
		ollama: defs.filter((d) => d.group === 'ollama')
	};
}

/** How many of `defs` hold a value of their own (the Controls button's dot, "Reset all"). */
export const overriddenCount = (params: Params | null | undefined, defs: ParamDef[] = paramDefs) =>
	defs.filter((d) => !isUnset(params?.[d.key])).length;

/** Whether a row matches the filter text, by its name, its API name or its help. */
export const matchesFilter = (def: ParamDef, filter: string) => {
	const q = filter.trim().toLowerCase();
	return !q || [def.label, def.key, def.help].some((t) => t.toLowerCase().includes(q));
};

/** A value as the resting row shows it: "Default (0.7)". */
export function shownValue(value: unknown): string {
	if (Array.isArray(value)) return value.join(', ');
	if (typeof value === 'boolean') return value ? 'On' : 'Off';
	return String(value);
}

/**
 * The next value when the tri-state button is clicked. These four cycle rather
 * than toggle, and each cycle is a different length:
 *   stream_response   default -> On -> Off -> default
 *   function_calling  default -> Native -> Legacy -> default
 *   think             default -> On -> Custom (an effort string) -> Off -> default
 *   reasoning_tags    default -> Custom (['', '']) -> Enabled -> Disabled -> default
 */
export function nextTri(
	tri: 'stream_response' | 'function_calling' | 'think' | 'reasoning_tags',
	value: unknown
): unknown {
	switch (tri) {
		case 'stream_response':
			return isUnset(value) ? true : value ? false : null;
		case 'function_calling':
			return isUnset(value) ? 'native' : value === 'native' ? 'legacy' : null;
		case 'think':
			return isUnset(value) ? true : value === true ? 'medium' : typeof value === 'string' ? false : null;
		case 'reasoning_tags':
			if (isUnset(value)) return ['', ''];
			if (Array.isArray(value) && value.length === 2) return true;
			return value !== false ? false : null;
	}
}

/** The label the tri-state button shows for the current value. */
export function triLabel(
	tri: 'stream_response' | 'function_calling' | 'think' | 'reasoning_tags',
	value: unknown
): string {
	switch (tri) {
		case 'stream_response':
			return value === true ? 'On' : value === false ? 'Off' : 'Default';
		case 'function_calling':
			return value === 'native' ? 'Native' : value === 'legacy' ? 'Legacy' : 'Default';
		case 'think':
			return value === true ? 'On' : value === false ? 'Off' : typeof value === 'string' ? 'Custom' : 'Default';
		case 'reasoning_tags':
			return isUnset(value) ? 'Default' : value === true ? 'Enabled' : value === false ? 'Disabled' : 'Custom';
	}
}
