import { useEffect, useState } from 'react';

/**
 * Returns `value` after it has stopped changing for `delayMs`. Replaces the
 * Svelte pages' hand-rolled `searchDebounceTimer`: they set `loading = true` on
 * each keystroke and clear a timeout; here the *query* is debounced and the
 * fetch simply depends on the debounced value, so there is no timer to leak.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
	const [debounced, setDebounced] = useState(value);
	useEffect(() => {
		const timer = setTimeout(() => setDebounced(value), delayMs);
		return () => clearTimeout(timer);
	}, [value, delayMs]);
	return debounced;
}
