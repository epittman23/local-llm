import { toast } from 'sonner';
import { create } from 'zustand';
import { deleteModel, pullModel } from '@/lib/apis/ollama';
import { isNotableStatus, lineReader, parseStreamLines, progressPercent, sanitizeModelTag, streamError } from './ollamaStreams';

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

const update = (tag: string, changes: Partial<Download>) => useDownloadPool.setState((s) => ({ pool: s.pool[tag] ? { ...s.pool, [tag]: { ...s.pool[tag], ...changes } } : s.pool }));
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
export async function startPull(token: string, rawTag: string, urlIdx: number | null, onDone?: () => void | Promise<void>): Promise<void> {
	const tag = sanitizeModelTag(rawTag);
	const { pool } = useDownloadPool.getState();
	if (pool[tag]) {
		toast.error(`Model '${tag}' is already in queue for downloading.`);
		return;
	}
	if (Object.keys(pool).length >= MAX_PARALLEL_DOWNLOADS) {
		toast.error(`Maximum of ${MAX_PARALLEL_DOWNLOADS} models can be downloaded simultaneously. Please try again later.`);
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
	useDownloadPool.setState((s) => ({ pool: { ...s.pool, [tag]: { abortController: controller ?? undefined, reader, done: false } } }));

	let aborted = false;
	for (;;) {
		try {
			const { value, done } = await reader.read();
			if (done) break;
			for (const data of parseStreamLines(value)) {
				const failure = streamError(data);
				if (failure) throw failure;
				if (!data.status) continue;
				if (data.digest) update(tag, { pullProgress: progressPercent(data), digest: data.digest });
				else update(tag, { done: data.status === 'success' });
			}
		} catch (err) {
			if ((err as Error)?.name === 'AbortError') {
				aborted = true;
				break;
			}
			toast.error(typeof err === 'string' ? err : `${(err as Error)?.message ?? err}`);
			// The stream is dead after an error the server sent; a parse error leaves it readable.
			if (typeof err === 'string') break;
		}
	}

	if (useDownloadPool.getState().pool[tag]?.done) {
		toast.success(`Model '${tag}' has been successfully downloaded.`);
		await onDone?.();
	} else if (!aborted && useDownloadPool.getState().pool[tag]) {
		toast.error('Download canceled');
	}
	remove(tag);
}

/** Stops a pull, and deletes the partial download it leaves. */
export async function cancelPull(token: string, tag: string): Promise<void> {
	const download = useDownloadPool.getState().pool[tag];
	if (!download) return;
	download.abortController?.abort();
	if (download.reader) {
		await download.reader.cancel().catch(() => undefined);
		remove(tag);
		await deleteModel(token, tag).catch(() => undefined);
		toast.success(`${tag} download has been canceled`);
	}
}
