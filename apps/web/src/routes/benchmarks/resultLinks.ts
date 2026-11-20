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
	const keys = entries(overrides).map(([key]) => key);
	return {
		serve: keys.filter((key) => key in SERVE_PARAM),
		version: keys.filter((key) => key in DEFINITION_FIELD),
		unsupported: keys.filter((key) => !(key in DEFINITION_FIELD))
	};
}

/** The Serve form filled with the overrides it takes; null when it takes none of them. */
export function serveLink(profile: string, overrides: Overrides | null | undefined): string | null {
	const params = new URLSearchParams({ profile });
	for (const [key, value] of entries(overrides)) if (key in SERVE_PARAM) params.set(SERVE_PARAM[key], value);
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
		if (key in DEFINITION_FIELD) params.set(`def.${DEFINITION_FIELD[key]}`, value);
	if ([...params.keys()].length === 1) return null;
	if (note) params.set('note', note);
	return `${routePaths.benchmarksServe}?${params}`;
}

/** "ngl 22, ubatch 1024": the knobs as their flags' short names, in a result's own order. */
export const knobsText = (overrides: Overrides | null | undefined): string =>
	entries(overrides)
		.map(([key, value]) => `${key} ${value}`)
		.join(', ');
