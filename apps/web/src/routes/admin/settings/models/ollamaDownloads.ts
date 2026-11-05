import { toast } from 'sonner';
import { create } from 'zustand';
import { pullModel } from '@/lib/apis/ollama';
import {
	isNotableStatus,
	lineReader,
	parseStreamLines,
	progressPercent,
	sanitizeModelTag,
	streamError
} from './ollamaStreams';

export const MAX_PARALLEL_DOWNLOADS = 3;

export type Download = {
	abortController?: AbortController;
	reader?: ReadableStreamDefaultReader<string>;
	done: boolean;
	pullProgress?: number;
	digest?: string;
};

type Pool = Record<string, Download>;

/**
 * The pulls in flight (`MODEL_DOWNLOAD_POOL` in the Svelte app). It lives outside
 * any component on purpose: closing the Manage dialog must not stop a download
 * that is half way through, and reopening it shows where it has got to.
 */
export const useDownloadPool = create<{ pool: Pool }>(() => ({ pool: {} }));

const update = (tag: string, changes: Partial<Download>) =>
	useDownloadPool.setState((s) => ({
		pool: s.pool[tag] ? { ...s.pool, [tag]: { ...s.pool[tag], ...changes } } : s.pool
	}));
const remove = (tag: string) =>
	useDownloadPool.setState((s) => {
		const { [tag]: _gone, ...rest } = s.pool;
		return { pool: rest };
	});

/**
 * Pulls `rawTag` from the Ollama library into instance `urlIdx`, tracking it in
 * the pool. Resolves when the pull ends (finished, cancelled or failed);
 * `onDone` runs after a successful one so the caller can refresh its lists.
 */
export async function startPull(
	token: string,
	rawTag: string,
	urlIdx: number | null,
	onDone?: () => void | Promise<void>
): Promise<void> {
	const tag = sanitizeModelTag(rawTag);
	const { pool } = useDownloadPool.getState();
	if (pool[tag]) {
		toast.error(`Model '${tag}' is already in queue for downloading.`);
		return;
	}
	if (Object.keys(pool).length >= MAX_PARALLEL_DOWNLOADS) {
		toast.error(
			`Maximum of ${MAX_PARALLEL_DOWNLOADS} models can be downloaded simultaneously. Please try again later.`
		);
		return;
	}

	let pulled: [Response | null, AbortController | null] = [null, null];
	try {
		pulled = (await pullModel(token, tag, urlIdx)) as [Response | null, AbortController | null];
	} catch (error) {
		if ((error as Error)?.name !== 'AbortError') toast.error(`${error}`);
	}
	const [res, controller] = pulled;
	if (!res) return;

	const reader = lineReader(res);
	useDownloadPool.setState((s) => ({
		pool: { ...s.pool, [tag]: { abortController: controller ?? undefined, reader, done: false } }
	}));

	let aborted = false;
	let failed = false;
	for (;;) {
		let chunk: ReadableStreamReadResult<string>;
		try {
			chunk = await reader.read();
		} catch (err) {
			// An errored stream rejects every later read too, so reading on would spin forever.
			if ((err as Error)?.name === 'AbortError') aborted = true;
			else {
				toast.error(`${(err as Error)?.message ?? err}`);
				failed = true;
			}
			break;
		}
		if (chunk.done) break;
		try {
			for (const data of parseStreamLines(chunk.value)) {
				const failure = streamError(data);
				if (failure) throw failure;
				if (!data.status) continue;
				if (data.digest) update(tag, { pullProgress: progressPercent(data), digest: data.digest });
				else update(tag, { done: data.status === 'success' });
			}
		} catch (err) {
			toast.error(typeof err === 'string' ? err : `${(err as Error)?.message ?? err}`);
			// The stream is dead after an error the server sent; a line that is not JSON leaves it readable.
			// Failed, like a read error, so "Download canceled" does not follow the error (#505).
			if (typeof err === 'string') {
				failed = true;
				break;
			}
		}
	}

	if (useDownloadPool.getState().pool[tag]?.done) {
		toast.success(`Model '${tag}' has been successfully downloaded.`);
		await onDone?.();
	} else if (!aborted && !failed && useDownloadPool.getState().pool[tag]) {
		toast.error('Download canceled');
	}
	remove(tag);
}

/**
 * Stops a pull. It deletes nothing: the delete it used to send had no
 * instance, so the backend could only match a model already listed under this
 * name (on any instance), in practice never the cancelled download itself
 * (#244). What happens to partially downloaded layers is up to Ollama.
 */
export async function cancelPull(tag: string): Promise<void> {
	const download = useDownloadPool.getState().pool[tag];
	if (!download) return;
	download.abortController?.abort();
	if (download.reader) {
		await download.reader.cancel().catch(() => undefined);
		remove(tag);
		toast.success(`${tag} download has been canceled`);
	}
}
