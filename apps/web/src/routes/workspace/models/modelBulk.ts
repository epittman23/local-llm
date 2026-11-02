import { toast } from 'sonner';
import { toggleModelById, updateModelById } from '@/lib/apis/models';

// The Models page's bulk Enable / Disable / Show / Hide All. They act only on
// models the user can write: the list strips a read-only model's params, so
// writing one back would replace its system prompt and parameters with `{}`
// (an admin without BYPASS_ADMIN_ACCESS_CONTROL gets that accepted), and the
// row has no switch or Hide item for it either.

type Json = Record<string, unknown>;

export type BulkRow = {
	id: string;
	name: string;
	base_model_id?: string | null;
	is_active?: boolean;
	write_access?: boolean;
	meta?: Json | null;
	params?: Json | null;
} & Json;

export type BulkAction = 'enable' | 'disable' | 'show' | 'hide';

const isActive = (m: BulkRow) => m.is_active ?? true;
const isHidden = (m: BulkRow) => m.meta?.hidden === true;

/** Which rows each action changes, before the write-access check. */
const needsChange: Record<BulkAction, (m: BulkRow) => boolean> = {
	enable: (m) => !isActive(m),
	disable: isActive,
	show: isHidden,
	hide: (m) => !isHidden(m)
};

/**
 * The update body that sets `meta.hidden` on a writable list row and changes
 * nothing else. It is built field by field instead of sending the row back:
 * `access_grants` is left out, so `/models/model/update` leaves the grants
 * alone (sending them would run them through the server's grant filter);
 * `is_active` is sent, since the server defaults a missing one to true; and
 * `chat_variables_schema`, which the server derives on read, is not written.
 * The list leaves `profile_image_url` out of meta, and the server keeps the
 * stored one when the key is absent; the same goes for a missing
 * `base_model_id`. A row without `params` is refused by the server rather than
 * saved with empty ones.
 */
export function visibilityUpdate(m: BulkRow, hidden: boolean): Json {
	const withHidden: Json = { ...m.meta, hidden };
	const { chat_variables_schema: _derived, ...meta } = withHidden;
	return {
		id: m.id,
		name: m.name,
		base_model_id: m.base_model_id,
		meta,
		params: m.params,
		is_active: isActive(m)
	};
}

/**
 * Saves one writable model's visibility (the row's Hide / Show Model) with the
 * body visibilityUpdate builds, and toasts the outcome. Returns whether it was
 * saved.
 */
export async function setVisibility(token: string, m: BulkRow, hidden: boolean) {
	try {
		if (!(await updateModelById(token, m.id, visibilityUpdate(m, hidden)))) return false;
		toast.success(`Model ${m.id} is now ${hidden ? 'hidden' : 'visible'}`);
		return true;
	} catch (e) {
		toast.error(`${e}`);
		return false;
	}
}

/**
 * Applies one bulk action to every row that needs it and that the user can
 * write. Returns how many were changed and how many read-only rows that needed
 * it were skipped. A row the paged list returned twice (its pages are not
 * ordered by a unique key) is acted on once, or a toggle would undo itself.
 */
export async function applyBulkAction(token: string, rows: BulkRow[], action: BulkAction) {
	const unique = [...new Map(rows.map((m) => [m.id, m])).values()];
	const targets = unique.filter(needsChange[action]);
	const writable = targets.filter((m) => m.write_access === true);
	await Promise.all(
		writable.map((m) =>
			action === 'enable' || action === 'disable'
				? toggleModelById(token, m.id)
				: updateModelById(token, m.id, visibilityUpdate(m, action === 'hide'))
		)
	);
	return { changed: writable.length, skipped: targets.length - writable.length };
}

const doneMessage: Partial<Record<BulkAction, string>> = {
	show: 'All models are now visible',
	hide: 'All models are now hidden'
};

/**
 * Runs one bulk action from the page over the rows `load` returns, and toasts
 * the outcome: the action's own message when every model it needed to change
 * was changed, a count of the read-only models it skipped otherwise, and any
 * error.
 */
export async function runBulkAction(token: string, load: () => Promise<BulkRow[]>, action: BulkAction) {
	try {
		const { changed, skipped } = await applyBulkAction(token, await load(), action);
		const done = doneMessage[action];
		if (done && changed > 0 && skipped === 0) toast.success(done);
		if (skipped > 0) toast.info(`Skipped ${skipped} read-only ${skipped === 1 ? 'model' : 'models'}`);
	} catch (e) {
		toast.error(`${e}`);
	}
}
