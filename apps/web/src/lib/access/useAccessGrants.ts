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
 * user may not set. A failed latest save puts back the grants the server last
 * confirmed: the reply of the newest save answered so far, which may be an
 * earlier save than the one that failed, or the grants the item loaded with.
 * A reply that dropped some warns instead of saying Saved. A reply with no
 * body says the save went through but cannot say what was kept, so the sent
 * grants stay and the user is told to check. Without `save` (an item not yet
 * created) a change is only kept, to be sent with the item.
 */
export function useAccessGrants(
	initial: AccessGrant[],
	save: ((grants: AccessGrant[]) => Promise<{ access_grants?: unknown } | null | undefined>) | null
) {
	const [grants, setGrants] = useState(initial);
	const saves = useRef(0);
	const confirmed = useRef({ seq: 0, grants: initial });
	const change = async (next: AccessGrant[]) => {
		setGrants(next);
		if (!save) return;
		const seq = ++saves.current;
		let failed = false;
		const res = await save(next).catch((e) => {
			failed = true;
			toast.error(`${e}`);
		});
		const latest = saves.current === seq;
		if (failed) {
			if (latest) setGrants(confirmed.current.grants);
			return;
		}
		if (!res) {
			toast.error('Saved, but the access could not be read back. Reopen the dialog to check it.');
			return;
		}
		const stored = res.access_grants;
		const kept = Array.isArray(stored) ? (stored as AccessGrant[]) : next;
		if (seq > confirmed.current.seq) confirmed.current = { seq, grants: kept };
		if (latest) setGrants(kept);
		if (grantsDropped(next, stored)) toast.warning(DROPPED_GRANTS_WARNING);
		else toast.success('Saved');
	};
	return [grants, change] as const;
}
