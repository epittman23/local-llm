export type ConfigMap = Record<string, any>;

/**
 * Older backends keyed `*_API_CONFIGS` by URL; current ones key by list index.
 * When an index has no entry, fall back to the URL's entry (or an empty one) --
 * Connections.svelte's "legacy support" loop. Returns a new map.
 */
export function normalizeConfigs(urls: string[], configs: ConfigMap | null | undefined): ConfigMap {
	const out: ConfigMap = { ...(configs ?? {}) };
	urls.forEach((url, idx) => {
		if (!out[idx]) out[idx] = out[url] || {};
	});
	return out;
}

/** Each URL without its trailing slash. */
export const stripTrailingSlashes = (urls: string[]) => urls.map((u) => u.replace(/\/$/, ''));

/** Keys line up with URLs one-to-one: extra keys are dropped, missing ones are empty. */
export function alignKeys(urls: string[], keys: string[]): string[] {
	return urls.map((_, i) => keys[i] ?? '');
}

/**
 * Removes connection `idx` from parallel URL / key lists and re-indexes the
 * config map so entries after it shift down (the config map is keyed by index).
 * `keys` may be omitted for Ollama, which stores its key inside each config.
 */
export function removeConnection(urls: string[], keys: string[] | null, configs: ConfigMap, idx: number) {
	const nextUrls = urls.filter((_, i) => i !== idx);
	const nextKeys = keys ? keys.filter((_, i) => i !== idx) : null;
	const nextConfigs: ConfigMap = {};
	nextUrls.forEach((_, newIdx) => {
		nextConfigs[newIdx] = configs[newIdx < idx ? newIdx : newIdx + 1];
	});
	return { urls: nextUrls, keys: nextKeys, configs: nextConfigs };
}
