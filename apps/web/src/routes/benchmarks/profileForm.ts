import type { ProfileDefinition } from '@/lib/apis/benchmarks/profiles';
import { dayjs } from '@/lib/utils/dates';

/**
 * What a profile definition's fields are called on screen (WRD-2): a name in
 * words, and the llama-server flag the launcher builds from it
 * (serving/launcher.py `build_argv`), shown beside it in mono. Shared by the
 * profile form, the Serve page's profile summary and the version history's
 * changes, so a field reads the same everywhere.
 */
export const FIELD_META = {
	arch: { label: 'Architecture' },
	alias: { label: 'Alias', flag: '--alias' },
	model_path: { label: 'Model file', flag: '-m' },
	hf_repo: { label: 'Hugging Face repository' },
	hf_pattern: { label: 'Hugging Face file pattern' },
	ngl: { label: 'GPU layers', flag: '-ngl' },
	moe: { label: 'Expert layers on the CPU', flag: '--n-cpu-moe' },
	override_tensors: { label: 'Override tensors', flag: '-ot' },
	ctx: { label: 'Context', flag: '-c' },
	parallel: { label: 'Parallel slots', flag: '--parallel' },
	threads: { label: 'Threads', flag: '-t' },
	batch: { label: 'Batch size', flag: '-b' },
	ubatch: { label: 'Micro-batch size', flag: '--ubatch-size' },
	cache_k: { label: 'K cache type', flag: '--cache-type-k' },
	cache_v: { label: 'V cache type', flag: '--cache-type-v' },
	reasoning_effort_default: { label: 'Default reasoning effort' },
	samplers: { label: 'Sampler arguments' },
	spec: { label: 'Speculative decoding arguments' },
	extra: { label: 'Extra arguments' },
	notes: { label: 'Notes' }
} as const satisfies Record<keyof ProfileDefinition, { label: string; flag?: string }>;

export type DefinitionKey = keyof typeof FIELD_META;

/** Every definition field, in the order the form groups them. */
export const DEFINITION_KEYS = Object.keys(FIELD_META) as DefinitionKey[];

const NUMBER_KEYS = new Set<DefinitionKey>(['ngl', 'moe', 'ctx', 'parallel', 'threads', 'batch', 'ubatch']);
const ARGV_KEYS = new Set<DefinitionKey>(['spec', 'samplers', 'extra']);

/** `validate_definition` accepts only these two (serving/profiles.py). */
export const ARCH_OPTIONS = [
	['dense', 'Dense'],
	['moe', 'Mixture of experts']
] as const;

/** The KV cache types llama-server's `--cache-type-k`/`-v` list as allowed values. */
export const CACHE_TYPES = ['f32', 'f16', 'bf16', 'q8_0', 'q4_0', 'q4_1', 'iq4_nl', 'q5_0', 'q5_1'] as const;

/** What `reasoning_effort` takes; empty means the model has no thinking budget (`resolve` sets none). */
export const REASONING_LEVELS = ['low', 'medium', 'high'] as const;

/**
 * B-D8: an enumeration as select options, keeping a stored value the list
 * does not know, labelled "(other) value", so opening a profile never
 * changes it.
 */
export function withOther(options: readonly (readonly [string, string])[], value: string | null | undefined) {
	if (!value || options.some(([v]) => v === value)) return options;
	return [...options, [value, `(other) ${value}`] as const];
}

// spec/samplers/extra are argv token lists on the backend
// (models/benchmarks/profiles.py), edited here as one command-line string.
// The raw text is kept as typed and only split on submit -- re-deriving the
// input's value from the parsed list on every keystroke ate commas and spaces
// (docs/history/bug-review-2026-09-27.md M7). Split shell-style: whitespace separates
// tokens, and single or double quotes keep a value with spaces or commas in
// one token (`-ot "a=CUDA0,b=CUDA0"`).
const quoteArg = (arg: string) => (/[\s'"]/.test(arg) || arg === '' ? `'${arg.replace(/'/g, `'"'"'`)}'` : arg);
export const argvToText = (values: string[] | null | undefined) => (values ?? []).map(quoteArg).join(' ');
export function textToArgv(text: string): string[] {
	const out: string[] = [];
	let cur = '';
	let has = false;
	let quote: '"' | "'" | null = null;
	for (const ch of text) {
		if (quote) {
			if (ch === quote) quote = null;
			else cur += ch;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
			has = true;
		} else if (/\s/.test(ch)) {
			if (has) out.push(cur);
			cur = '';
			has = false;
		} else {
			cur += ch;
			has = true;
		}
	}
	if (has) out.push(cur);
	return out;
}

/** A definition value as one line of text: a list as its command line, nothing as an en dash (DAT-2). */
export function showValue(key: DefinitionKey, value: unknown): string {
	if (ARGV_KEYS.has(key)) return Array.isArray(value) && value.length ? argvToText(value as string[]) : '–';
	if (value === null || value === undefined || value === '') return '–';
	return String(value);
}

/** The fields that differ between two definitions, in form order, as "before → after" text. */
export function definitionChanges(
	before: Partial<ProfileDefinition>,
	after: Partial<ProfileDefinition>
): { key: DefinitionKey; before: string; after: string }[] {
	return DEFINITION_KEYS.flatMap((key) => {
		const from = showValue(key, before[key]);
		const to = showValue(key, after[key]);
		return from === to ? [] : [{ key, before: from, after: to }];
	});
}

/** A record's time (DAT-5): `2026-11-14 22:46`. */
export const recordTime = (seconds: number) => dayjs(seconds * 1000).format('YYYY-MM-DD HH:mm');

/**
 * The prefill a link carries for a new version (B-D8: "Create profile
 * version" on a Tune result or a Pre-screen candidate):
 * `?edit=<profile>&def.<field>=<value>&note=<text>`. Numbers are digits,
 * argument lists one command line; unknown or malformed fields are ignored.
 */
export function prefillFromParams(params: URLSearchParams): {
	name: string;
	changes: Partial<ProfileDefinition>;
	note: string;
} | null {
	const name = params.get('edit');
	if (!name) return null;
	const changes: Partial<Record<DefinitionKey, unknown>> = {};
	for (const [param, raw] of params) {
		if (!param.startsWith('def.')) continue;
		const key = param.slice(4) as DefinitionKey;
		if (!(key in FIELD_META)) continue;
		if (NUMBER_KEYS.has(key)) {
			if (/^\d+$/.test(raw.trim())) changes[key] = Number(raw);
			else if (key === 'moe' && raw.trim() === '') changes[key] = null;
		} else if (key === 'spec' && (raw.trim() === 'off' || raw.trim() === '')) {
			// A Tune grid's spec-off value is an override's word, not an argument:
			// saved as `off` it would reach llama-server bare (serving/profiles.py refuses it too).
			changes[key] = [];
		} else if (ARGV_KEYS.has(key)) changes[key] = textToArgv(raw);
		else changes[key] = raw;
	}
	return { name, changes: changes as Partial<ProfileDefinition>, note: params.get('note') ?? '' };
}

/** The search parameters a prefilled edit link adds, so closing the dialog can take them off again. */
export const isEditParam = (param: string) => param === 'edit' || param === 'note' || param.startsWith('def.');
