export type ArenaModel = {
	id: string;
	name: string;
	meta: {
		profile_image_url: string;
		description: string | null;
		model_ids: string[] | null;
		filter_mode: 'include' | 'exclude' | null;
		access_grants: unknown[];
	};
};

/** "My Arena Model!" -> "my-arena-model": the id follows the name until the model is being edited. */
export const arenaIdFromName = (name: string) =>
	name
		.toLowerCase()
		.replace(/[^a-z0-9]/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');

/**
 * The arena model the modal submits. Empty description / model list become null
 * (not '' / []), and the include/exclude mode is only meaningful when specific
 * models are listed -- an empty list means "all models", so its mode is null.
 */
export function buildArenaModel(fields: {
	id: string;
	name: string;
	profileImageUrl: string;
	description: string;
	modelIds: string[];
	filterMode: 'include' | 'exclude';
	accessGrants: unknown[];
}): ArenaModel {
	return {
		id: fields.id,
		name: fields.name,
		meta: {
			profile_image_url: fields.profileImageUrl,
			description: fields.description || null,
			model_ids: fields.modelIds.length > 0 ? fields.modelIds : null,
			filter_mode: fields.modelIds.length > 0 ? fields.filterMode : null,
			access_grants: fields.accessGrants
		}
	};
}
