import { type AccessGrant, dedupeAccessGrants } from '@/lib/access/accessGrants';

// Models arrive from three places the app doesn't control -- an imported JSON
// file, a message from the community site, and a model being shared out. Same
// rule as Prompts/Skills/Tools: only the model's own fields cross the boundary,
// and access grants never come in from outside.

type Json = Record<string, any>;

export type IncomingModel = {
	id: string;
	name: string;
	base_model_id: string | null;
	meta: Json;
	params: Json;
	access_grants: AccessGrant[];
};

const isObject = (v: unknown): v is Json => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

/**
 * Shapes one model-like object. Accepts the bare model or the community site's
 * `{ info: {...} }` wrapper. `id` and `name` are required. Grants are kept only
 * when `withGrants` (a same-origin clone of a model the user could already see).
 */
export function sanitizeIncomingModel(raw: unknown, { withGrants }: { withGrants: boolean }): IncomingModel | null {
	const wrapped = isObject(raw) && isObject(raw.info) ? raw.info : raw;
	if (!isObject(wrapped)) return null;
	const id = str(wrapped.id, 200);
	const name = str(wrapped.name, 200);
	if (!id || !name) return null;
	return {
		id,
		name,
		base_model_id: typeof wrapped.base_model_id === 'string' ? wrapped.base_model_id : null,
		meta: isObject(wrapped.meta) ? JSON.parse(JSON.stringify(wrapped.meta)) : {},
		params: isObject(wrapped.params) ? JSON.parse(JSON.stringify(wrapped.params)) : {},
		access_grants: withGrants && Array.isArray(wrapped.access_grants) ? dedupeAccessGrants(wrapped.access_grants as AccessGrant[]) : []
	};
}

/** Parses an imported models file: a JSON array; entries that are not usable models are skipped. */
export function parseModelImport(text: string): IncomingModel[] {
	const parsed: unknown = JSON.parse(text);
	if (!Array.isArray(parsed)) throw new Error('Expected a JSON array of models.');
	return parsed.flatMap((item) => {
		const model = sanitizeIncomingModel(item, { withGrants: false });
		return model ? [model] : [];
	});
}

/** What "Share to Community" sends: the model's own definition, not its author, grants or timestamps. */
export function modelSharePayload(model: Json) {
	return {
		id: model.id,
		name: model.name,
		base_model_id: model.base_model_id ?? null,
		meta: model.meta ?? {},
		params: model.params ?? {}
	};
}
