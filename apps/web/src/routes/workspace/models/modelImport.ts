import { type AccessGrant, dedupeAccessGrants } from '@/lib/access/accessGrants';
import { createNewModel, getModelById, importModels, updateModelById } from '@/lib/apis/models';

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
		access_grants:
			withGrants && Array.isArray(wrapped.access_grants)
				? dedupeAccessGrants(wrapped.access_grants as AccessGrant[])
				: []
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

/**
 * The update body for an imported model whose id already exists. The file's
 * meta is merged over the existing meta, as the server's own `/models/import`
 * does. Unlike that endpoint, the file never changes the model's sharing or
 * enabled state: `access_grants` is left out, so `/models/model/update` leaves
 * the grants alone, and `is_active` always comes from the existing model. A
 * file without a base model keeps the existing one. `chat_variables_schema` is
 * derived from the system prompt on read (and so is in an export), so it is not
 * written.
 */
export function importUpdate(existing: Json, incoming: IncomingModel): Json {
	const { chat_variables_schema: _derived, ...meta } = { ...existing.meta, ...incoming.meta };
	return {
		id: incoming.id,
		name: incoming.name,
		base_model_id: incoming.base_model_id ?? existing.base_model_id,
		meta,
		params: incoming.params,
		is_active: existing.is_active
	};
}

/**
 * The models an admin's import sends to the server's `/models/import`, which
 * updates a model whose id exists and creates the rest. For an existing model
 * that endpoint keeps whatever a model leaves out, so `access_grants` is left
 * out (the file never brings any, and an empty list would wipe the model's
 * sharing), and so is a base model the file does not name (#524). A new model
 * starts with no grants and no base model either way.
 */
export function importPayload(models: IncomingModel[]): Json[] {
	return models.map(({ access_grants: _never, base_model_id, ...model }) =>
		base_model_id ? { ...model, base_model_id } : model
	);
}

/** Imports a models file as Admin Settings > Models does: parsed, then sent as `importPayload` shapes it. */
export const importModelFile = async (token: string, text: string) =>
	importModels(token, importPayload(parseModelImport(text)));

/** Saves one imported model: updates the model with its id (see importUpdate), or creates it when there is none. */
export async function saveImportedModel(token: string, model: IncomingModel) {
	const existing = await getModelById(token, model.id).catch(() => null);
	return existing ? updateModelById(token, model.id, importUpdate(existing, model)) : createNewModel(token, model);
}
