type Rec = Record<string, any>;

/** One ComfyUI workflow input: which key of which node(s) receives a value. `node_ids` is the comma-separated text being edited. */
export type NodeRow = { type: string; key: string; node_ids: string };

export const DEFAULT_WORKFLOW_NODES: NodeRow[] = [
	{ type: 'prompt', key: 'text', node_ids: '' },
	{ type: 'model', key: 'ckpt_name', node_ids: '' },
	{ type: 'width', key: 'width', node_ids: '' },
	{ type: 'height', key: 'height', node_ids: '' },
	{ type: 'steps', key: 'steps', node_ids: '' },
	{ type: 'seed', key: 'seed', node_ids: '' }
];

export const DEFAULT_EDIT_WORKFLOW_NODES: NodeRow[] = [
	{ type: 'image', key: 'image', node_ids: '' },
	{ type: 'prompt', key: 'prompt', node_ids: '' },
	{ type: 'model', key: 'unet_name', node_ids: '' },
	{ type: 'width', key: 'width', node_ids: '' },
	{ type: 'height', key: 'height', node_ids: '' }
];

/** The rows to edit: each default type, taking the server's key and ids when it has that type. */
export function toNodeRows(defaults: NodeRow[], fromServer: { type: string; key: string; node_ids?: string | string[] }[] | null | undefined): NodeRow[] {
	return defaults.map((d) => {
		const n = fromServer?.find((s) => s.type === d.type);
		if (!n) return d;
		return { type: n.type, key: n.key, node_ids: Array.isArray(n.node_ids) ? n.node_ids.join(',') : (n.node_ids ?? '') };
	});
}

/** The list the backend stores: ids split on commas, trimmed, blanks dropped. */
export const fromNodeRows = (rows: NodeRow[]) =>
	rows.map((r) => ({
		type: r.type,
		key: r.key,
		node_ids: r.node_ids
			.split(',')
			.map((id) => id.trim())
			.filter(Boolean)
	}));

const isPlainObject = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v);

/** `text` re-indented when it is JSON, untouched when it is not (the backend keeps a workflow as a string). */
export function prettyJson(text: unknown): string {
	if (typeof text !== 'string') return text == null ? '' : JSON.stringify(text, null, 2);
	try {
		return JSON.stringify(JSON.parse(text), null, 2);
	} catch {
		return text;
	}
}

/** The "Additional Parameters" text as an object: blank is `{}`; anything but a JSON object is null. */
export function parseParams(text: unknown): Rec | null {
	if (isPlainObject(text)) return text;
	if (typeof text !== 'string' || text.trim() === '') return {};
	try {
		const v = JSON.parse(text);
		return isPlainObject(v) ? v : null;
	} catch {
		return null;
	}
}

export const isJsonObject = (text: string): boolean => parseParams(text) !== null && text.trim() !== '';

const blank = (v: unknown) => String(v ?? '').trim() === '';

/**
 * What image generation cannot run without, for the chosen engine. Only asked
 * of an admin who is turning generation on: the check is a reason not to leave
 * it on, and an unrelated edit (say, to Image Edit) should not be refused
 * because a generation engine nobody uses has no key.
 */
export function missingGenerationSetting(config: Rec): string | null {
	if (!config.ENABLE_IMAGE_GENERATION) return null;
	switch (config.IMAGE_GENERATION_ENGINE) {
		case 'automatic1111':
			return blank(config.AUTOMATIC1111_BASE_URL) ? 'AUTOMATIC1111 Base URL is required.' : null;
		case 'comfyui':
			return blank(config.COMFYUI_BASE_URL) ? 'ComfyUI Base URL is required.' : null;
		case 'openai':
			return blank(config.IMAGES_OPENAI_API_KEY) ? 'OpenAI API Key is required.' : null;
		case 'gemini':
			return blank(config.IMAGES_GEMINI_API_KEY) ? 'Gemini API Key is required.' : null;
		default:
			return null;
	}
}

export type Prepared = { ok: true; payload: Rec } | { ok: false; error: string; disableGeneration?: boolean };

/**
 * The body of `POST /images/config/update`, or the reason it cannot be sent.
 * The workflows and params live in the form as text; the backend wants the
 * workflow as a string (JSON, validated here) and the params as objects.
 */
export function prepareImagesConfig(config: Rec, nodes: NodeRow[], editNodes: NodeRow[]): Prepared {
	const payload: Rec = { ...config };

	if (config.COMFYUI_WORKFLOW) {
		if (!isJsonObject(config.COMFYUI_WORKFLOW)) return { ok: false, error: 'Invalid JSON format for ComfyUI Workflow.' };
		payload.COMFYUI_WORKFLOW_NODES = fromNodeRows(nodes);
	}
	if (config.IMAGES_EDIT_COMFYUI_WORKFLOW) {
		if (!isJsonObject(config.IMAGES_EDIT_COMFYUI_WORKFLOW)) return { ok: false, error: 'Invalid JSON format for ComfyUI Edit Workflow.' };
		payload.IMAGES_EDIT_COMFYUI_WORKFLOW_NODES = fromNodeRows(editNodes);
	}

	const missing = missingGenerationSetting(config);
	if (missing) return { ok: false, error: missing, disableGeneration: true };

	const automatic1111 = parseParams(config.AUTOMATIC1111_PARAMS);
	if (!automatic1111) return { ok: false, error: 'Invalid JSON format for AUTOMATIC1111 Additional Parameters.' };
	const openai = parseParams(config.IMAGES_OPENAI_API_PARAMS);
	if (!openai) return { ok: false, error: 'Invalid JSON format for OpenAI Additional Parameters.' };
	payload.AUTOMATIC1111_PARAMS = automatic1111;
	payload.IMAGES_OPENAI_API_PARAMS = openai;

	return { ok: true, payload };
}

/** The config as first shown: workflows and params re-indented, node lists turned into rows. */
export function toFormState(config: Rec) {
	return {
		config: {
			...config,
			COMFYUI_WORKFLOW: config.COMFYUI_WORKFLOW ? prettyJson(config.COMFYUI_WORKFLOW) : config.COMFYUI_WORKFLOW,
			IMAGES_EDIT_COMFYUI_WORKFLOW: config.IMAGES_EDIT_COMFYUI_WORKFLOW ? prettyJson(config.IMAGES_EDIT_COMFYUI_WORKFLOW) : config.IMAGES_EDIT_COMFYUI_WORKFLOW,
			AUTOMATIC1111_PARAMS: typeof config.AUTOMATIC1111_PARAMS === 'object' ? JSON.stringify(config.AUTOMATIC1111_PARAMS ?? {}, null, 2) : config.AUTOMATIC1111_PARAMS,
			IMAGES_OPENAI_API_PARAMS: typeof config.IMAGES_OPENAI_API_PARAMS === 'object' ? JSON.stringify(config.IMAGES_OPENAI_API_PARAMS ?? {}, null, 2) : config.IMAGES_OPENAI_API_PARAMS
		} as Rec,
		nodes: toNodeRows(DEFAULT_WORKFLOW_NODES, config.COMFYUI_WORKFLOW_NODES),
		editNodes: toNodeRows(DEFAULT_EDIT_WORKFLOW_NODES, config.IMAGES_EDIT_COMFYUI_WORKFLOW_NODES)
	};
}
