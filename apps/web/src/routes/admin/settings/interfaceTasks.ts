// The rules behind Interface.tsx (ported from admin/Settings/Interface.svelte).

export type ModelOption = {
	id: string;
	name: string;
	connection_type?: string;
	access_grants?: { principal_type: string; principal_id: string; permission: string }[];
};

/** Drops unset values so a parameter left at "Default" is not sent as an override. */
export const configuredParams = (params: Record<string, unknown> = {}): Record<string, unknown> =>
	Object.fromEntries(Object.entries(params).filter(([, value]) => value !== null && value !== '' && value !== undefined));

/**
 * Task models run for every user, so one that is not readable by everyone would
 * fail for most of them. A model with no grant information at all (a plain
 * connection model, not a workspace model) is fine.
 */
export const isPubliclyReadable = (model: Pick<ModelOption, 'access_grants'>): boolean =>
	!model.access_grants || model.access_grants.some((g) => g.principal_type === 'user' && g.principal_id === '*' && g.permission === 'read');

/**
 * What a model `<select>` should hold after the user picks `id`: the id if it is
 * one of the options, else '' ("Current Model"). `warn` says the pick is valid
 * but not public -- the Svelte tab shows a toast and keeps the selection.
 */
export const normalizeModelSelection = (id: string | null | undefined, options: ModelOption[]): { value: string; warn: boolean } => {
	if (!id) return { value: '', warn: false };
	const model = options.find((m) => m.id === id);
	if (!model) return { value: '', warn: false };
	return { value: model.id, warn: !isPubliclyReadable(model) };
};

/** Connection models overlaid with their workspace-model record, when there is one. */
export const mergeModelOptions = (base: ModelOption[], workspace: ModelOption[]): ModelOption[] =>
	base.map((m) => {
		const w = workspace.find((x) => x.id === m.id);
		return w ? { ...m, ...w } : { ...m };
	});
