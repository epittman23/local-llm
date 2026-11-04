export type ValveSpec = {
	properties: Record<string, { title?: string; description?: string; type?: string; enum?: unknown[] }>;
};
export type ValveValues = Record<string, unknown>;

/**
 * Array valves are edited as comma-separated text; join them for the form. An
 * unset (null) one stays null, which the form shows as "None": as '' it showed
 * as an empty, required Custom field, and the tab could not be saved until it
 * was filled in or switched back (#251).
 */
export function valvesToForm(valves: ValveValues, spec: ValveSpec): ValveValues {
	const form = { ...valves };
	for (const [key, prop] of Object.entries(spec.properties ?? {})) {
		if (prop?.type === 'array')
			form[key] = Array.isArray(valves[key]) ? (valves[key] as unknown[]).join(',') : (valves[key] ?? null);
	}
	return form;
}

/**
 * ...and split them back for the server: `"a, b ,c"` -> `['a','b','c']`. An
 * unset (null) array valve stays null rather than becoming `['']`; the Svelte
 * version calls `.split` on `(value ?? '')` and so sends `['']` for it.
 */
export function formToValves(form: ValveValues, spec: ValveSpec): ValveValues {
	const valves = { ...form };
	for (const [key, prop] of Object.entries(spec.properties ?? {})) {
		if (prop?.type !== 'array') continue;
		const raw = form[key];
		valves[key] =
			raw === null || raw === undefined
				? null
				: String(raw)
						.split(',')
						.map((v) => v.trim());
	}
	return valves;
}
