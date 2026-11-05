import { beforeEach, describe, expect, it, vi } from 'vitest';

const { toastError, toastSuccess, pullModel, deleteModel, lineReader } = vi.hoisted(() => ({
	toastError: vi.fn(),
	toastSuccess: vi.fn(),
	pullModel: vi.fn(),
	deleteModel: vi.fn(),
	lineReader: vi.fn()
}));
vi.mock('sonner', () => ({ toast: { error: toastError, success: toastSuccess } }));
vi.mock('@/lib/apis/ollama', () => ({ pullModel, deleteModel }));
vi.mock('./ollamaStreams', async (importActual) => ({
	...(await importActual<typeof import('./ollamaStreams')>()),
	lineReader
}));

import { cancelPull, startPull, useDownloadPool } from './ollamaDownloads';

type Read = () => Promise<ReadableStreamReadResult<string>>;

/**
 * A reader that plays `steps` in order, then reports the end of the stream.
 * The end is a backstop: a loop that keeps reading after an error stops
 * there and the test fails on its count, instead of spinning forever.
 */
const fakeReader = (steps: Read[]) => {
	let i = 0;
	const read = vi.fn(() => (i < steps.length ? steps[i++]() : Promise.resolve({ done: true, value: undefined })));
	return { read, cancel: vi.fn().mockResolvedValue(undefined) };
};
const line =
	(value: string): Read =>
	() =>
		Promise.resolve({ done: false, value });
const fail =
	(error: unknown): Read =>
	() =>
		Promise.reject(error);

const pullWith = (reader: ReturnType<typeof fakeReader>) => {
	pullModel.mockResolvedValue([new Response(''), new AbortController()]);
	lineReader.mockReturnValue(reader);
};

beforeEach(() => {
	vi.clearAllMocks();
	deleteModel.mockResolvedValue(true);
	useDownloadPool.setState({ pool: {} });
});

describe('startPull', () => {
	it('stops at a stream that errors instead of reading it again (#245)', async () => {
		const brokenStream = Array.from({ length: 50 }, () => fail(new TypeError('network error')));
		const reader = fakeReader(brokenStream);
		pullWith(reader);
		const onDone = vi.fn();

		await startPull('t', 'llama3:8b', 1, onDone);

		expect(reader.read).toHaveBeenCalledTimes(1);
		expect(toastError).toHaveBeenCalledExactlyOnceWith('network error');
		expect(toastSuccess).not.toHaveBeenCalled();
		expect(onDone).not.toHaveBeenCalled();
		expect(useDownloadPool.getState().pool).toEqual({});
	});

	it('reports a successful pull even when one line is not JSON', async () => {
		const reader = fakeReader([
			line('{"status":"pulling a1","digest":"a1","completed":1,"total":2}'),
			line('oops'),
			line('{"status":"success"}')
		]);
		pullWith(reader);
		const onDone = vi.fn();

		await startPull('t', 'ollama pull llama3:8b', null, onDone);

		expect(pullModel).toHaveBeenCalledWith('t', 'llama3:8b', null);
		expect(toastError).toHaveBeenCalledTimes(1);
		expect(toastSuccess).toHaveBeenCalledWith("Model 'llama3:8b' has been successfully downloaded.");
		expect(onDone).toHaveBeenCalledOnce();
	});

	it('stops at an error the server sends', async () => {
		const reader = fakeReader([
			line('{"error":"pull model manifest: file does not exist"}'),
			line('{"status":"success"}')
		]);
		pullWith(reader);

		await startPull('t', 'nope:1b', 0);

		expect(reader.read).toHaveBeenCalledTimes(1);
		expect(toastError).toHaveBeenNthCalledWith(1, 'pull model manifest: file does not exist');
		expect(toastSuccess).not.toHaveBeenCalled();
	});

	it('shows one toast for an error the server sends, not "Download canceled" after it (#505)', async () => {
		pullWith(fakeReader([line('{"error":"pull model manifest: file does not exist"}')]));

		await startPull('t', 'nope:1b', 0);

		expect(toastError.mock.calls).toEqual([['pull model manifest: file does not exist']]);
		expect(useDownloadPool.getState().pool).toEqual({});
	});

	it('ends quietly when the pull is aborted', async () => {
		const reader = fakeReader([fail(new DOMException('aborted', 'AbortError'))]);
		pullWith(reader);

		await startPull('t', 'llama3:8b', 0);

		expect(reader.read).toHaveBeenCalledTimes(1);
		expect(toastError).not.toHaveBeenCalled();
		expect(useDownloadPool.getState().pool).toEqual({});
	});
});

describe('cancelPull', () => {
	it('stops the pull without deleting a model of the same name (#244)', async () => {
		const abortController = new AbortController();
		const reader = fakeReader([]);
		useDownloadPool.setState({
			pool: { 'llama3:8b': { abortController, reader: reader as never, done: false } }
		});

		await cancelPull('llama3:8b');

		expect(abortController.signal.aborted).toBe(true);
		expect(reader.cancel).toHaveBeenCalledOnce();
		expect(deleteModel).not.toHaveBeenCalled();
		expect(useDownloadPool.getState().pool).toEqual({});
		expect(toastSuccess).toHaveBeenCalledWith('llama3:8b download has been canceled');
	});

	it('does nothing for a tag that is not downloading', async () => {
		await cancelPull('llama3:8b');

		expect(deleteModel).not.toHaveBeenCalled();
		expect(toastSuccess).not.toHaveBeenCalled();
	});
});
