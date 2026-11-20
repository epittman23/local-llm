import { routePaths } from '@/routes/routePaths';

/**
 * Tune's and Pre-screen's results name serving knobs as llama-env keys
 * (`LLAMA_UBATCH`) or as their lower-case short form (`ubatch`, a pre-screen
 * candidate's `changes`). These turn a result into the two links the Serve
 * page reads (B-D8, the URL contract in the section's plan):
 *
 * - `/benchmarks/serve?profile=&ngl=&ctx=&threads=&parallel=&ot=&reasoning=&spec=`
 *   fills the Serve form with one-off overrides and never starts anything;
 * - `/benchmarks/serve?edit=<profile>&def.<field>=<value>…&note=` opens the
 *   profile's Edit form with those fields changed, saved only on Save.
 */

/** `LLAMA_UBATCH` and `ubatch` alike become `ubatch`. */
export const knobKey = (key: string): string => key.replace(/^LLAMA_/, '').toLowerCase();

/**
 * llama-server's speculative-decoding options, the only ones an override's
 * `spec` may hold: a copy of serving/profiles.py's SPEC_OPTIONS (read from
 * llama.cpp build 11875's common/arg.cpp), which the server enforces with a
 * 422. test_serving_profiles.py checks that the two lists agree.
 */
export const SPEC_OPTIONS: ReadonlySet<string> = new Set([
	'--spec-draft-threads',
	'-td',
	'--threads-draft',
	'--spec-draft-threads-batch',
	'-tbd',
	'--threads-batch-draft',
	'--spec-draft-cpu-mask',
	'-Cd',
	'--cpu-mask-draft',
	'--spec-draft-cpu-range',
	'-Crd',
	'--cpu-range-draft',
	'--spec-draft-cpu-strict',
	'--cpu-strict-draft',
	'--spec-draft-prio',
	'--prio-draft',
	'--spec-draft-poll',
	'--poll-draft',
	'--spec-draft-cpu-mask-batch',
	'-Cbd',
	'--cpu-mask-batch-draft',
	'--spec-draft-cpu-range-batch',
	'-Crbd',
	'--cpu-range-batch-draft',
	'--spec-draft-cpu-strict-batch',
	'--cpu-strict-batch-draft',
	'--spec-draft-prio-batch',
	'--prio-batch-draft',
	'--spec-draft-poll-batch',
	'--poll-batch-draft',
	'--spec-draft-type-k',
	'-ctkd',
	'--cache-type-k-draft',
	'--spec-draft-type-v',
	'-ctvd',
	'--cache-type-v-draft',
	'--spec-draft-override-tensor',
	'-otd',
	'--override-tensor-draft',
	'--spec-draft-cpu-moe',
	'-cmoed',
	'--cpu-moe-draft',
	'--spec-draft-n-cpu-moe',
	'--spec-draft-ncmoe',
	'-ncmoed',
	'--n-cpu-moe-draft',
	'--spec-draft-n-max',
	'--spec-draft-n-min',
	'--spec-draft-n-ubatch',
	'--spec-synth-len',
	'--spec-synth-rates',
	'--spec-draft-p-split',
	'--draft-p-split',
	'--spec-draft-p-min',
	'--draft-p-min',
	'--spec-draft-backend-sampling',
	'--no-spec-draft-backend-sampling',
	'--spec-draft-sampling',
	'--spec-draft-device',
	'-devd',
	'--device-draft',
	'--spec-draft-ngl',
	'-ngld',
	'--gpu-layers-draft',
	'--n-gpu-layers-draft',
	'--spec-draft-model',
	'-md',
	'--model-draft',
	'--spec-type',
	'--spec-ngram-mod-n-min',
	'--spec-ngram-mod-n-max',
	'--spec-ngram-mod-n-match',
	'--spec-ngram-simple-size-n',
	'--spec-ngram-simple-size-m',
	'--spec-ngram-simple-min-hits',
	'--spec-ngram-map-k-size-n',
	'--spec-ngram-map-k-size-m',
	'--spec-ngram-map-k-min-hits',
	'--spec-ngram-map-k4v-size-n',
	'--spec-ngram-map-k4v-size-m',
	'--spec-ngram-map-k4v-min-hits',
	'--draft',
	'--draft-n',
	'--draft-max',
	'--draft-min',
	'--draft-n-min',
	'--spec-ngram-size-n',
	'--spec-ngram-size-m',
	'--spec-ngram-min-hits',
	'--spec-default'
]);

/**
 * Whether Serve may take this `spec` from a link: empty, `off`, or only
 * speculative options and their values, the rule of profiles.py's
 * check_speculative_args. Anything else (`--host 0.0.0.0`) never becomes a
 * one-off override, from a link or a result.
 */
export function speculativeOnly(value: string): boolean {
	const args = value.trim().split(/\s+/).filter(Boolean);
	if (args.length === 0 || (args.length === 1 && args[0] === 'off')) return true;
	return args.every((arg, i) => {
		if (!arg.startsWith('-') || /^-\d+(\.\d+)?$/.test(arg)) return i > 0;
		return SPEC_OPTIONS.has(arg.startsWith('--') ? `--${arg.slice(2).replaceAll('_', '-')}` : arg);
	});
}

/** The Serve page's override parameters, by knob. */
const SERVE_PARAM: Record<string, string> = {
	ngl: 'ngl',
	ctx: 'ctx',
	threads: 'threads',
	parallel: 'parallel',
	ot: 'ot',
	reasoning: 'reasoning',
	spec: 'spec'
};

/** A profile definition's field, by knob (serving/profiles.py's Overrides.from_env). */
const DEFINITION_FIELD: Record<string, string> = {
	ngl: 'ngl',
	ctx: 'ctx',
	threads: 'threads',
	moe: 'moe',
	parallel: 'parallel',
	batch: 'batch',
	ubatch: 'ubatch',
	cache_k: 'cache_k',
	cache_v: 'cache_v',
	ot: 'override_tensors',
	reasoning: 'reasoning_effort_default',
	spec: 'spec'
};

/** Knobs in words, for the sentences around the links (WRD-2). */
const KNOB_NAMES: Record<string, string> = {
	ngl: 'GPU layers',
	ctx: 'context',
	threads: 'threads',
	moe: 'MoE layers on the CPU',
	parallel: 'parallel slots',
	batch: 'batch',
	ubatch: 'micro-batch',
	cache_k: 'K cache type',
	cache_v: 'V cache type',
	ot: 'tensor overrides',
	reasoning: 'reasoning effort',
	spec: 'speculative decoding',
	fa: 'flash attention'
};

export const knobName = (key: string): string => KNOB_NAMES[knobKey(key)] ?? knobKey(key);

type Overrides = Record<string, unknown>;

const entries = (overrides: Overrides | null | undefined): [string, string][] =>
	Object.entries(overrides ?? {})
		.filter(([, value]) => value !== null && value !== undefined && value !== '')
		.map(([key, value]) => [knobKey(key), String(value)]);

/** Which knobs each link can carry, and which neither can (flash attention has no profile field). */
export function splitKnobs(overrides: Overrides | null | undefined): {
	serve: string[];
	version: string[];
	unsupported: string[];
} {
	const all = entries(overrides);
	const keys = all.map(([key]) => key);
	// Flags other than speculative ones fit neither link: a profile's extra arguments, by hand.
	const refused = all.filter(([key, value]) => key === 'spec' && !speculativeOnly(value)).map(([key]) => key);
	return {
		serve: keys.filter((key) => key in SERVE_PARAM && !refused.includes(key)),
		version: keys.filter((key) => key in DEFINITION_FIELD && !refused.includes(key)),
		unsupported: keys.filter((key) => !(key in DEFINITION_FIELD) || refused.includes(key))
	};
}

/** The Serve form filled with the overrides it takes; null when it takes none of them. */
export function serveLink(profile: string, overrides: Overrides | null | undefined): string | null {
	const params = new URLSearchParams({ profile });
	for (const [key, value] of entries(overrides))
		if (key in SERVE_PARAM && (key !== 'spec' || speculativeOnly(value))) params.set(SERVE_PARAM[key], value);
	return [...params.keys()].length > 1 ? `${routePaths.benchmarksServe}?${params}` : null;
}

/** The profile's Edit form with these fields changed; null when no field can hold them. */
export function profileVersionLink(
	profile: string,
	overrides: Overrides | null | undefined,
	note?: string
): string | null {
	const params = new URLSearchParams({ edit: profile });
	for (const [key, value] of entries(overrides))
		if (key in DEFINITION_FIELD && (key !== 'spec' || speculativeOnly(value)))
			params.set(`def.${DEFINITION_FIELD[key]}`, value);
	if ([...params.keys()].length === 1) return null;
	if (note) params.set('note', note);
	return `${routePaths.benchmarksServe}?${params}`;
}

/** "ngl 22, ubatch 1024": the knobs as their flags' short names, in a result's own order. */
export const knobsText = (overrides: Overrides | null | undefined): string =>
	entries(overrides)
		.map(([key, value]) => `${key} ${value}`)
		.join(', ');
