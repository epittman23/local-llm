import { describe, expect, it, vi } from 'vitest';
import { type UpdateSteps, updateModels, updateSummary } from './ollamaStreams';

// #246: "Update All Models" caught every pull failure to the console and then
// always said "All models are up to date", even when every pull had failed.

const stream = (lines: object[], status = 200) =>
	new Response(lines.map((line) => `${JSON.stringify(line)}\n`).join(''), { status });

const steps = (pull: UpdateSteps['pull'], cancelled = () => false) => {
	const seen = { models: [] as string[], progress: [] as number[], done: [] as string[], controllers: [] as string[] };
	const s: UpdateSteps = {
		pull,
		isCancelled: cancelled,
		onModel: (id) => seen.models.push(id),
		onController: (id, controller) => {
			if (controller) seen.controllers.push(id);
		},
		onProgress: (p) => seen.progress.push(p),
		onDone: (id) => seen.done.push(id)
	};
	return { s, seen };
};

describe('updateModels', () => {
	it('pulls each model and reports none failed when every pull succeeds', async () => {
		const { s, seen } = steps(async () => [
			stream([{ status: 'pulling', digest: 'sha', completed: 1, total: 2 }, { status: 'success' }]),
			new AbortController()
		]);

		const outcome = await updateModels(['a', 'b'], s);

		expect(outcome).toEqual({ failed: [], cancelled: false });
		expect(seen.models).toEqual(['a', 'b']);
		expect(seen.controllers).toEqual(['a', 'b']);
		expect(seen.progress).toEqual([50, 50]);
		expect(seen.done).toEqual(['a', 'b']);
	});

	it('reports a pull that could not reach the server', async () => {
		const { s, seen } = steps(async () => {
			throw new Error('Failed to fetch');
		});

		const outcome = await updateModels(['a', 'b'], s);

		expect(outcome.failed).toEqual([
			{ id: 'a', error: 'Failed to fetch' },
			{ id: 'b', error: 'Failed to fetch' }
		]);
		expect(seen.done).toEqual(['a', 'b']);
	});

	it('reports an error the stream carries, and a refusal without one', async () => {
		const responses: Record<string, Response> = {
			a: stream([{ error: 'pull model manifest: file does not exist' }]),
			b: stream([{ detail: 'Ollama: unreachable' }], 500),
			c: stream([], 502),
			d: stream([{ status: 'success' }])
		};
		const { s } = steps(async (id) => [responses[id], null]);

		const outcome = await updateModels(['a', 'b', 'c', 'd'], s);

		expect(outcome.failed).toEqual([
			{ id: 'a', error: 'pull model manifest: file does not exist' },
			{ id: 'b', error: 'Ollama: unreachable' },
			{ id: 'c', error: 'HTTP 502' }
		]);
	});

	it('a cancelled pull is not a failure, and the update stops there', async () => {
		let cancelled = false;
		const pull = vi.fn(async () => {
			cancelled = true;
			throw new DOMException('aborted', 'AbortError');
		});
		const { s, seen } = steps(pull, () => cancelled);

		const outcome = await updateModels(['a', 'b'], s);

		expect(outcome).toEqual({ failed: [], cancelled: true });
		expect(pull).toHaveBeenCalledTimes(1);
		expect(seen.models).toEqual(['a']);
	});

	it('a stream aborted mid-read is not a failure', async () => {
		const body = new ReadableStream({
			start(controller) {
				controller.error(new DOMException('aborted', 'AbortError'));
			}
		});
		const { s } = steps(async () => [new Response(body), new AbortController()]);

		expect((await updateModels(['a'], s)).failed).toEqual([]);
	});
});

describe('updateSummary', () => {
	it('says cancelled, then the failures, then all up to date', () => {
		expect(updateSummary({ failed: [{ id: 'a', error: 'x' }], cancelled: true })).toEqual([
			'info',
			'Model update cancelled'
		]);
		expect(updateSummary({ failed: [{ id: 'a', error: 'x' }], cancelled: false })).toEqual([
			'error',
			'Could not update 1 model: a (x)'
		]);
		expect(
			updateSummary({
				failed: [
					{ id: 'a', error: 'x' },
					{ id: 'b', error: 'y' }
				],
				cancelled: false
			})
		).toEqual(['error', 'Could not update 2 models: a (x), b (y)']);
		expect(updateSummary({ failed: [], cancelled: false })).toEqual(['success', 'All models are up to date']);
	});
});
