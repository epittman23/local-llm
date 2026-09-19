// The parameter table behind <AdvancedParams>. The Svelte component
// (chat/Settings/Advanced/AdvancedParams.svelte, 1,465 lines) spells out each of
// these ~30 controls by hand; nearly all follow one pattern -- a "Default /
// Custom" toggle that, when on Custom, shows a control seeded with a starting
// value -- so here they are rows in a table and one renderer handles them all.
// The seeds, ranges, labels and tooltip text are copied from that component.

export type ParamDef = {
	key: string;
	label: string;
	tip: string;
	/** Only shown to admins (server-side / Ollama-level settings). */
	admin?: boolean;
} & (
	| { kind: 'range'; seed: number; min: number; max: number; step: number; numberStep?: number | 'any'; numberMax?: number | null; integer?: boolean }
	| { kind: 'number'; seed: number; min: number; step: number; placeholder: string }
	| { kind: 'text'; seed: string; placeholder: string }
	| { kind: 'switch'; seed: boolean }
	| { kind: 'tri'; tri: 'stream_response' | 'function_calling' | 'think' | 'reasoning_tags' }
);

export const paramDefs: ParamDef[] = [
	{ key: 'stream_response', label: 'Stream Chat Response', kind: 'tri', tri: 'stream_response', tip: 'When enabled, the model will respond to each chat message in real-time, generating a response as soon as the user sends a message. This mode is useful for live chat applications, but may impact performance on slower hardware.' },
	{ key: 'stream_delta_chunk_size', label: 'Stream Delta Chunk Size', admin: true, kind: 'range', seed: 1, min: 1, max: 128, step: 1, numberStep: 'any', numberMax: null, tip: 'The stream delta chunk size for the model. Increasing the chunk size will make the model respond with larger pieces of text at once.' },
	{ key: 'compact_token_threshold', label: 'Context Compaction Threshold', admin: true, kind: 'number', seed: 80000, min: 1, step: 1, placeholder: 'Enter token threshold', tip: 'Set a model-specific context compaction token threshold. When set, this overrides the global threshold up to the global cap.' },
	{ key: 'function_calling', label: 'Function Calling', kind: 'tri', tri: 'function_calling', tip: "Native mode (default) leverages the model's built-in tool-calling capabilities. Legacy mode works with a wider range of models by calling tools once before execution via prompt injection." },
	{ key: 'reasoning_tags', label: 'Reasoning Tags', kind: 'tri', tri: 'reasoning_tags', tip: 'Enable, disable, or customize the reasoning tags used by the model. "Enabled" uses default tags, "Disabled" turns off reasoning tags, and "Custom" lets you specify your own start and end tags.' },
	{ key: 'seed', label: 'Seed', kind: 'number', seed: 0, min: 0, step: 1, placeholder: 'Enter Seed', tip: 'Sets the random number seed to use for generation. Setting this to a specific number will make the model generate the same text for the same prompt.' },
	{ key: 'stop', label: 'Stop Sequence', kind: 'text', seed: '', placeholder: 'Enter stop sequence', tip: 'Sets the stop sequences to use. When this pattern is encountered, the LLM will stop generating text and return. Multiple stop patterns may be set by specifying multiple separate stop parameters in a modelfile.' },
	{ key: 'temperature', label: 'Temperature', kind: 'range', seed: 0.8, min: 0, max: 2, step: 0.05, tip: 'The temperature of the model. Increasing the temperature will make the model answer more creatively.' },
	{ key: 'reasoning_effort', label: 'Reasoning Effort', kind: 'text', seed: 'medium', placeholder: 'Enter reasoning effort', tip: 'Constrains effort on reasoning for reasoning models. Only applicable to reasoning models from specific providers that support reasoning effort.' },
	{ key: 'logit_bias', label: 'logit_bias', kind: 'text', seed: '', placeholder: 'Enter comma-separated "token:bias_value" pairs (example: 5432:100, 413:-100)', tip: 'Boosting or penalizing specific tokens for constrained responses. Bias values will be clamped between -100 and 100 (inclusive). (Default: none)' },
	{ key: 'max_tokens', label: 'max_tokens', kind: 'range', seed: 128, min: -2, max: 131072, step: 1, numberStep: 1, numberMax: null, tip: 'This option sets the maximum number of tokens the model can generate in its response. Increasing this limit allows the model to provide longer answers, but it may also increase the likelihood of unhelpful or irrelevant content being generated.' },
	{ key: 'top_k', label: 'top_k', kind: 'range', seed: 40, min: 0, max: 1000, step: 1, numberStep: 1, integer: true, tip: 'Reduces the probability of generating nonsense. A higher value (e.g. 100) will give more diverse answers, while a lower value (e.g. 10) will be more conservative.' },
	{ key: 'top_p', label: 'top_p', kind: 'range', seed: 0.9, min: 0, max: 1, step: 0.05, tip: 'Works together with top-k. A higher value (e.g., 0.95) will lead to more diverse text, while a lower value (e.g., 0.5) will generate more focused and conservative text.' },
	{ key: 'min_p', label: 'min_p', kind: 'range', seed: 0, min: 0, max: 1, step: 0.05, tip: 'Alternative to the top_p, and aims to ensure a balance of quality and variety. The parameter p represents the minimum probability for a token to be considered, relative to the probability of the most likely token. For example, with p=0.05 and the most likely token having a probability of 0.9, logits with a value less than 0.045 are filtered out.' },
	{ key: 'frequency_penalty', label: 'frequency_penalty', kind: 'range', seed: 1.1, min: -2, max: 2, step: 0.05, tip: 'Sets a scaling bias against tokens to penalize repetitions, based on how many times they have appeared. A higher value (e.g., 1.5) will penalize repetitions more strongly, while a lower value (e.g., 0.9) will be more lenient. At 0, it is disabled.' },
	{ key: 'presence_penalty', label: 'presence_penalty', kind: 'range', seed: 0, min: -2, max: 2, step: 0.05, tip: 'Sets a flat bias against tokens that have appeared at least once. A higher value (e.g., 1.5) will penalize repetitions more strongly, while a lower value (e.g., 0.9) will be more lenient. At 0, it is disabled.' },
	{ key: 'mirostat', label: 'mirostat', kind: 'range', seed: 0, min: 0, max: 2, step: 1, numberStep: 1, tip: 'Enable Mirostat sampling for controlling perplexity.' },
	{ key: 'mirostat_eta', label: 'mirostat_eta', kind: 'range', seed: 0.1, min: 0, max: 1, step: 0.05, tip: 'Influences how quickly the algorithm responds to feedback from the generated text. A lower learning rate will result in slower adjustments, while a higher learning rate will make the algorithm more responsive.' },
	{ key: 'mirostat_tau', label: 'mirostat_tau', kind: 'range', seed: 5, min: 0, max: 10, step: 0.5, tip: 'Controls the balance between coherence and diversity of the output. A lower value will result in more focused and coherent text.' },
	{ key: 'repeat_last_n', label: 'repeat_last_n', kind: 'range', seed: 64, min: -1, max: 128, step: 1, numberStep: 1, tip: 'Sets how far back for the model to look back to prevent repetition.' },
	{ key: 'tfs_z', label: 'tfs_z', kind: 'range', seed: 1, min: 0, max: 2, step: 0.05, tip: 'Tail free sampling is used to reduce the impact of less probable tokens from the output. A higher value (e.g., 2.0) will reduce the impact more, while a value of 1.0 disables this setting.' },
	{ key: 'repeat_penalty', label: 'repeat_penalty', kind: 'range', seed: 1.1, min: -2, max: 2, step: 0.05, tip: 'Control the repetition of token sequences in the generated text. A higher value (e.g., 1.5) will penalize repetitions more strongly, while a lower value (e.g., 1.1) will be more lenient. At 1, it is disabled.' },
	{ key: 'use_mmap', label: 'use_mmap', admin: true, kind: 'switch', seed: true, tip: 'Enable Memory Mapping (mmap) to load model data. This option allows the system to use disk storage as an extension of RAM by treating disk files as if they were in RAM. This can improve model performance by allowing for faster data access. However, it may not work correctly with all systems and can consume a significant amount of disk space.' },
	{ key: 'use_mlock', label: 'use_mlock', admin: true, kind: 'switch', seed: true, tip: "Enable Memory Locking (mlock) to prevent model data from being swapped out of RAM. This option locks the model's working set of pages into RAM, ensuring that they will not be swapped out to disk. This can help maintain performance by avoiding page faults and ensuring fast data access." },
	{ key: 'think', label: 'think (Ollama)', admin: true, kind: 'tri', tri: 'think', tip: 'This option enables or disables the use of the reasoning feature in Ollama, which allows the model to think before generating a response. When enabled, the model can take a moment to process the conversation context and generate a more thoughtful response.' },
	{ key: 'format', label: 'format (Ollama)', admin: true, kind: 'text', seed: 'json', placeholder: 'e.g. "json" or a JSON schema', tip: 'The format to return a response in. Format can be json or a JSON schema.' },
	{ key: 'num_keep', label: 'num_keep (Ollama)', admin: true, kind: 'range', seed: 24, min: -1, max: 10240000, step: 1, numberStep: 1, numberMax: null, tip: 'This option controls how many tokens are preserved when refreshing the context. For example, if set to 2, the last 2 tokens of the conversation context will be retained. Preserving context can help maintain the continuity of a conversation, but it may reduce the ability to respond to new topics.' },
	{ key: 'num_ctx', label: 'num_ctx (Ollama)', admin: true, kind: 'range', seed: 2048, min: -1, max: 10240000, step: 1, numberStep: 1, numberMax: null, tip: 'Sets the size of the context window used to generate the next token.' },
	{ key: 'num_batch', label: 'num_batch (Ollama)', admin: true, kind: 'range', seed: 512, min: 256, max: 8192, step: 256, numberStep: 256, numberMax: null, tip: 'The batch size determines how many text requests are processed together at once. A higher batch size can increase the performance and speed of the model, but it also requires more memory.' },
	{ key: 'num_thread', label: 'num_thread (Ollama)', admin: true, kind: 'range', seed: 2, min: 1, max: 256, step: 1, numberStep: 1, tip: 'Set the number of worker threads used for computation. This option controls how many threads are used to process incoming requests concurrently. Increasing this value can improve performance under high concurrency workloads but may also consume more CPU resources.' },
	{ key: 'num_gpu', label: 'num_gpu (Ollama)', admin: true, kind: 'range', seed: 0, min: 0, max: 256, step: 1, numberStep: 1, tip: 'Set the number of layers, which will be off-loaded to GPU. Increasing this value can significantly improve performance for models that are optimized for GPU acceleration but may also consume more power and GPU resources.' },
	{ key: 'keep_alive', label: 'keep_alive (Ollama)', admin: true, kind: 'text', seed: '5m', placeholder: "e.g. '30s','10m'. Valid time units are 's', 'm', 'h'.", tip: 'This option controls how long the model will stay loaded into memory following the request (default: 5m)' }
];

export type Params = Record<string, any>;

/** `null`/`undefined` both mean "not overridden". */
export const isUnset = (value: unknown) => (value ?? null) === null;

/**
 * The next value when the tri-state button is clicked. These four cycle rather
 * than toggle, and each cycle is a different length:
 *   stream_response   default -> On -> Off -> default
 *   function_calling  default -> Native -> Legacy -> default
 *   think             default -> On -> Custom (an effort string) -> Off -> default
 *   reasoning_tags    default -> Custom (['', '']) -> Enabled -> Disabled -> default
 */
export function nextTri(tri: 'stream_response' | 'function_calling' | 'think' | 'reasoning_tags', value: unknown): unknown {
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
export function triLabel(tri: 'stream_response' | 'function_calling' | 'think' | 'reasoning_tags', value: unknown): string {
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
