import type { Params } from '@/components/common/advancedParamDefs';

// Pure rules behind the personal Settings tabs.

/**
 * What General saves (Settings/General.svelte's saveHandler): the system
 * prompt (dropped when empty) and the parameters that are set, with the stop
 * sequences as a list.
 */
export function generalPatch(system: string, params: Params) {
	const out: Params = {};
	for (const [k, v] of Object.entries(params)) {
		if (v === null || v === undefined || v === '') continue;
		if (k === 'stop') {
			const list = (typeof v === 'string' ? v.split(',') : (v as string[])).filter((s) => s);
			if (list.length) out.stop = list;
			continue;
		}
		if (k === 'custom_params' && (!v || typeof v !== 'object' || !Object.keys(v).length)) continue;
		out[k] = v;
	}
	return { system: system !== '' ? system : undefined, params: out };
}

/** The saved parameters as the form shows them: stop sequences joined with commas. */
export const paramsForForm = (params: Params | undefined): Params => ({
	...(params ?? {}),
	stop: params?.stop ? (Array.isArray(params.stop) ? params.stop.join(',') : params.stop) : null
});

export type VariableRow = { key: string; value: string };
const VARIABLE_KEY = /^[a-z][a-z0-9_]*$/;

/**
 * Account.svelte's user variables, rows to the API's map: blank rows are
 * dropped, keys must be lowercase snake case and unique (throws the message
 * to show otherwise).
 */
export function variablesPayload(rows: VariableRow[]): Record<string, string> {
	const out: Record<string, string> = Object.create(null);
	for (const row of rows) {
		const key = row.key.trim();
		if (!key && !row.value) continue;
		if (!VARIABLE_KEY.test(key)) throw new Error('Variable keys must use lowercase snake case.');
		if (Object.prototype.hasOwnProperty.call(out, key)) throw new Error('Variable keys must be unique.');
		out[key] = row.value ?? '';
	}
	return { ...out };
}

/** The API's map back to editable rows. */
export const variableRows = (variables: unknown): VariableRow[] =>
	variables && typeof variables === 'object'
		? Object.entries(variables as Record<string, unknown>).map(([key, value]) => ({ key, value: String(value ?? '') }))
		: [];
