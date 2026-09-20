import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

/**
 * The load / edit / save shape every admin Settings tab has: fetch a config
 * object from the backend once, let the user edit a local copy, then send it
 * back. `draft` is null until the first load lands (render a spinner), and is
 * *not* replaced by later refetches, so a focus refetch cannot clobber edits.
 * `gcTime: 0` means reopening the tab starts from the server's current values.
 *
 * `reload()` re-reads the server and resets the draft (after a save that changes
 * derived state, or a discard).
 */
export function useConfigDraft<T extends object>(key: readonly unknown[], fetcher: () => Promise<T | null | undefined>) {
	const query = useQuery({
		queryKey: ['admin-settings', ...key],
		queryFn: async () => (await fetcher()) ?? null,
		gcTime: 0,
		staleTime: Infinity,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false
	});
	const [draft, setDraft] = useState<T | null>(null);
	const seeded = useRef(false);

	useEffect(() => {
		if (!seeded.current && query.data) {
			seeded.current = true;
			setDraft(structuredClone(query.data));
		}
	}, [query.data]);
	useEffect(() => {
		if (query.isError) toast.error(`${query.error}`);
	}, [query.isError, query.error]);

	const patch = useCallback((changes: Partial<T>) => setDraft((d) => (d ? { ...d, ...changes } : d)), []);
	const reload = useCallback(async () => {
		const res = await query.refetch();
		if (res.data) setDraft(structuredClone(res.data));
	}, [query]);

	return { draft, setDraft, patch, reload, isLoading: draft === null && !query.isError, isError: query.isError };
}
