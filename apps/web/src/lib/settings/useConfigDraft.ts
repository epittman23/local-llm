import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

/** A value as JSON with object keys sorted and empty values ('', null, undefined) dropped, for comparing drafts. */
const canonical = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === 'object')
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.filter((k) => !isEmpty((value as Record<string, unknown>)[k]))
				.map((k) => [k, canonical((value as Record<string, unknown>)[k])])
		);
	return value;
};
const isEmpty = (v: unknown) => v === undefined || v === null || v === '';

/**
 * Whether two drafts hold the same settings: key order does not count, and an
 * emptied box ('') is the same as one never set (null, undefined), so typing
 * into a field and deleting it again is not a change.
 */
export const sameSettings = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/**
 * The load / edit / save shape every admin Settings tab has: fetch a config
 * object from the backend once, let the user edit a local copy, then send it
 * back. `draft` is null until the first load lands (render a spinner), and is
 * *not* replaced by later refetches, so a focus refetch cannot clobber edits.
 * `gcTime: 0` means reopening the tab starts from the server's current values.
 *
 * `reload()` re-reads the server and resets the draft (after a save that changes
 * derived state, or a discard).
 *
 * FRM-3 (#951): `saved` is what the server holds, as last loaded or saved;
 * `dirty` says the draft differs from it (pass it to `SettingsForm`, with
 * `discard`, which puts the draft back). A tab calls `commit(sent)` after a
 * save succeeds, never after one fails, so the SaveBar then says "All changes
 * saved"; `commit(answer, true)` also shows the server's answer in the form.
 */
export function useConfigDraft<T extends object>(
	key: readonly unknown[],
	fetcher: () => Promise<T | null | undefined>
) {
	const query = useQuery({
		queryKey: ['admin-settings', ...key],
		// A load that resolves to nothing is a failure, not an empty config:
		// otherwise the tab waits on a spinner for a draft that never comes.
		queryFn: async () => {
			const data = await fetcher();
			if (data === null || data === undefined) throw new Error('Could not load these settings');
			return data;
		},
		gcTime: 0,
		staleTime: Infinity,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false
	});
	const [draft, setDraft] = useState<T | null>(null);
	const [saved, setSaved] = useState<T | null>(null);
	const seeded = useRef(false);

	useEffect(() => {
		if (!seeded.current && query.data) {
			seeded.current = true;
			setDraft(structuredClone(query.data));
			setSaved(structuredClone(query.data));
		}
	}, [query.data]);
	useEffect(() => {
		if (query.isError) toast.error(query.error instanceof Error ? query.error.message : `${query.error}`);
	}, [query.isError, query.error]);

	const patch = useCallback((changes: Partial<T>) => setDraft((d) => (d ? { ...d, ...changes } : d)), []);
	const reload = useCallback(async () => {
		const res = await query.refetch();
		if (res.data) {
			setDraft(structuredClone(res.data));
			setSaved(structuredClone(res.data));
		}
	}, [query]);
	const discard = useCallback(() => setDraft(saved && structuredClone(saved)), [saved]);
	const commit = useCallback((value: T, show = false) => {
		setSaved(structuredClone(value));
		if (show) setDraft(structuredClone(value));
	}, []);
	const dirty = draft !== null && saved !== null && !sameSettings(draft, saved);

	return {
		draft,
		setDraft,
		patch,
		reload,
		saved,
		dirty,
		discard,
		commit,
		isLoading: draft === null && !query.isError,
		isError: query.isError
	};
}
