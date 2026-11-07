import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { type AccessGrant, DROPPED_GRANTS_WARNING, grantsDropped } from './accessGrants';

/**
 * An item's grants as its access dialog shows them, and the dialog's
 * `onChange`, for an item whose grants save on each change (skills, prompts,
 * tools; #676, as #522 for knowledge bases and #482 for notes).
 *
 * A change is shown at once, so a second edit made before the reply builds on
 * the first. Only the latest save's reply is applied: the server replaces the
 * grants wholesale and answers with those it stored, after dropping those this
 * user may not set. A failed latest save puts back the grants from before it,
 * and a reply that dropped some warns instead of saying Saved. Without `save`
 * (an item not yet created) a change is only kept, to be sent with the item.
 */
export function useAccessGrants(
	initial: AccessGrant[],
	save: ((grants: AccessGrant[]) => Promise<{ access_grants?: unknown } | null | undefined>) | null
) {
	const [grants, setGrants] = useState(initial);
	const saves = useRef(0);
	const change = async (next: AccessGrant[]) => {
		const previous = grants;
		setGrants(next);
		if (!save) return;
		const seq = ++saves.current;
		const res = await save(next).catch((e) => void toast.error(`${e}`));
		const latest = saves.current === seq;
		if (!res) {
			if (latest) setGrants(previous);
			return;
		}
		const stored = res.access_grants;
		if (latest && Array.isArray(stored)) setGrants(stored as AccessGrant[]);
		if (grantsDropped(next, stored)) toast.warning(DROPPED_GRANTS_WARNING);
		else toast.success('Saved');
	};
	return [grants, change] as const;
}
