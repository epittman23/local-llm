import { errorBody, errorMessage, isAbort } from '@/lib/apis/errors';
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

export type UpdateOutcome = { failed: { id: string; error: string }[]; cancelled: boolean };

export type UpdateSteps = {
	pull: (id: string) => Promise<[Response | null, AbortController | null]>;
	isCancelled: () => boolean;
	/** The model about to be pulled, then (with its controller, once there is one) the pull in flight. */
	onModel: (id: string) => void;
	onController: (id: string, controller: AbortController | null) => void;
	onProgress: (percent: number) => void;
	onDone: (id: string) => void;
};

/**
 * "Update All Models": pulls each model in turn, and says which pulls failed.
 * A failure used to go to the console only, and the result was always
 * "All models are up to date", even when every pull failed (#246).
 * A cancelled pull is not a failure.
 */
export async function updateModels(ids: string[], steps: UpdateSteps): Promise<UpdateOutcome> {
	const failed: UpdateOutcome['failed'] = [];
	const fail = (id: string, error: unknown) => {
		if (!isAbort(error)) failed.push({ id, error: errorMessage(error) });
	};
	for (const id of ids) {
		if (steps.isCancelled()) break;
		steps.onModel(id);
		let pulled: [Response | null, AbortController | null] = [null, null];
		try {
			pulled = await steps.pull(id);
		} catch (error) {
			fail(id, error);
		}
		const [res, controller] = pulled;
		steps.onController(id, controller);
		try {
			if (res && !res.ok) {
				// A refusal: its body says why (FastAPI's detail, Ollama's error, or
				// a proxy's page), and is not a stream of progress.
				fail(id, await errorBody(res));
			} else if (res?.body) {
				const reader = lineReader(res);
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					for (const data of parseStreamLines(value)) {
						const failure = streamError(data);
						if (failure) throw new Error(failure);
						if (data.status && data.digest) steps.onProgress(progressPercent(data));
					}
				}
			}
		} catch (error) {
			fail(id, error);
		}
		steps.onDone(id);
	}
	return { failed, cancelled: steps.isCancelled() };
}

/** The models that failed, grouped by why: one Ollama outage is one reason, not one per model. */
const failureList = (failed: UpdateOutcome['failed']): string => {
	const byError = new Map<string, string[]>();
	for (const { id, error } of failed) byError.set(error, [...(byError.get(error) ?? []), id]);
	const reasons = [...byError].map(([error, ids]) => `${ids.join(', ')} (${error})`).join('; ');
	return `Could not update ${failed.length} model${failed.length === 1 ? '' : 's'}: ${reasons}`;
};

/** The toast an update ends with: the failures (even after a cancel), cancelled, or all up to date. */
export const updateSummary = ({ failed, cancelled }: UpdateOutcome): ['info' | 'error' | 'success', string] => {
	if (failed.length > 0)
		return ['error', cancelled ? `Model update cancelled. ${failureList(failed)}` : failureList(failed)];
	if (cancelled) return ['info', 'Model update cancelled'];
	return ['success', 'All models are up to date'];
};
