import { useCallback, useEffect, useMemo, useRef } from 'react';

/**
 * Returns a stable `schedule(arg)` that calls `fn(arg)` once `delayMs` has
 * passed without another call. An autosave's pending call is flushed (run at
 * once) on unmount rather than dropped, as the Svelte pages' timers kept
 * running after navigation (#228). The call always goes to the `fn` of the
 * latest render, so it sees the current token and props; nothing runs on
 * unmount when nothing is pending. `schedule.flush()` runs a pending call at
 * once, for a caller whose pending call belongs to something being left, such
 * as the chat page's params when another chat opens.
 */
export function useDebouncedCallback<T>(
	fn: (arg: T) => unknown,
	delayMs: number
): ((arg: T) => void) & { flush: () => void } {
	const fnRef = useRef(fn);
	fnRef.current = fn;
	const pending = useRef<{ arg: T; timer: ReturnType<typeof setTimeout> } | null>(null);

	const flush = useCallback(() => {
		const call = pending.current;
		if (!call) return;
		pending.current = null;
		clearTimeout(call.timer);
		void fnRef.current(call.arg);
	}, []);

	useEffect(() => flush, [flush]);

	return useMemo(
		() =>
			Object.assign(
				(arg: T) => {
					if (pending.current) clearTimeout(pending.current.timer);
					pending.current = { arg, timer: setTimeout(flush, delayMs) };
				},
				{ flush }
			),
		[delayMs, flush]
	);
}
