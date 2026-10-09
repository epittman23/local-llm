import { splitStream } from '@/lib/utils/api-helpers';

type Rec = Record<string, any>;

/** A streamed response (`pull`, `create`, `upload`) as a reader of newline-separated chunks. */
export const lineReader = (res: Response) =>
	res.body!.pipeThrough(new TextDecoderStream()).pipeThrough(splitStream('\n')).getReader();

/** The JSON objects in one chunk of a stream. `data: ` prefixes (the upload endpoint's server-sent events) are dropped. */
export const parseStreamLines = (chunk: string): Rec[] =>
	chunk
		.split('\n')
		.filter((line) => line !== '')
		.map((line) => JSON.parse(line.replace(/^data: /, '')));

/** How far along a transfer is: Ollama sends `completed` and `total` while a layer moves, and neither once it has landed. */
export const progressPercent = (data: { completed?: number; total?: number }): number =>
	data.completed && data.total ? Math.round((data.completed / data.total) * 1000) / 10 : 100;

/** The error a stream message carries (the server's, or the proxy's), or null. */
export const streamError = (data: Rec): string | null => {
	const error = data.error ?? data.detail ?? null;
	return error === null ? null : typeof error === 'string' ? error : JSON.stringify(error);
};

/** What to call a tag the way people paste it: `ollama run mistral:7b` and `ollama pull mistral:7b` both mean `mistral:7b`. */
export const sanitizeModelTag = (tag: string): string => tag.trim().replace(/^ollama\s+(run|pull)\s+/, '');

/**
 * A status line worth showing as a toast: one that is not a per-layer transfer
 * update (those have a digest) and not the noise while writing blobs.
 */
export const isNotableStatus = (data: Rec): boolean =>
	Boolean(data.status) && !data.digest && !data.status.includes('writing') && !data.status.includes('sha256');

/** The size of a model as the delete list shows it: `name (4.1 GB)`. */
export const modelLabel = (model: { name?: string; id: string; size?: number }): string =>
	`${model.name ?? model.id} (${((model.size ?? 0) / 1024 ** 3).toFixed(1)} GB)`;

/** The Modelfile the GGUF upload creates its model from. */
export const uploadedModelfile = (digest: string, content: string) => `FROM @${digest}\n${content}`;

/** The stock Modelfile shown for an uploaded GGUF. */
export const DEFAULT_MODELFILE = `TEMPLATE """{{ .System }}\nUSER: {{ .Prompt }}\nASSISTANT: """\nPARAMETER num_ctx 4096\nPARAMETER stop "</s>"\nPARAMETER stop "USER:"\nPARAMETER stop "ASSISTANT:"`;
