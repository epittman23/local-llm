import { useEffect, useRef, useState } from 'react';
import { chatCompletion } from '@/lib/apis/openai';
import { useAuthStore } from '@/lib/stores/authStore';
import { type PlaygroundStats, readCompletionStream, type StreamUsage } from './playgroundModel';

/** Starts the request: a chat completion by default, or a text completion. */
export type StreamRequest = (
	token: string,
	body: object,
	controller: AbortController
) => Promise<[Response | null, AbortController]>;

/** How a run ended: its error (null when it finished or was stopped) and its speed (D8). */
export type RunResult = { error: string | null; stats: PlaygroundStats };

const sendChat: StreamRequest = (token, body, controller) => chatCompletion(token, body, undefined, controller);

/**
 * Runs a streamed completion, with a Stop that aborts the request itself (the
 * Svelte loop only stopped between chunks). The controller exists before the
 * request starts, so Stop and leaving the page abort it while it still waits
 * for its first byte too: a slow local model can take a long time to answer
 * at all, and the request used to run on (#207).
 *
 * A failure is returned, not toasted, so the page shows it where the reply
 * would have been, with Retry (#968, FBK-1). The result also carries the time
 * to the first token and, when the provider reported usage, the tokens and
 * tokens per second.
 */
export function useStreamRunner(send: StreamRequest = sendChat) {
	const token = useAuthStore((s) => s.token) ?? '';
	const [running, setRunning] = useState(false);
	const controller = useRef<AbortController | null>(null);
	useEffect(() => () => controller.current?.abort(), []);
	const run = async (body: object, onText: (t: string) => void): Promise<RunResult> => {
		// A run still going is stopped, so no request is left that Stop cannot reach.
		controller.current?.abort();
		const ctrl = new AbortController();
		controller.current = ctrl;
		setRunning(true);
		const started = performance.now();
		let first: number | undefined;
		let usage: StreamUsage | undefined;
		let error: string | null = null;
		try {
			const [res] = await send(token, body, ctrl);
			await readCompletionStream(
				res,
				(text) => {
					first ??= performance.now();
					onText(text);
				},
				ctrl.signal,
				(u) => {
					usage = u;
				}
			);
		} catch (err) {
			if (!ctrl.signal.aborted) error = `${err instanceof Error ? err.message : err}`;
		} finally {
			// Only the latest run ends the running state; an earlier one it replaced does not.
			if (controller.current === ctrl) {
				controller.current = null;
				setRunning(false);
			}
		}
		return { error, stats: speed(started, first, performance.now(), usage) };
	};
	return { running, run, stop: () => controller.current?.abort('User: Stop Response') };
}

const MIN_RATE_SPAN_MS = 100;

/** The time to the first token, and the generation rate over the time after it, when the tokens are known. */
export function speed(started: number, first: number | undefined, ended: number, usage?: StreamUsage): PlaygroundStats {
	if (first === undefined) return {};
	const stats: PlaygroundStats = { ttftMs: first - started };
	const tokens = usage?.completion_tokens;
	if (typeof tokens === 'number') {
		stats.tokens = tokens;
		// A reply that arrived all at once (a cached or very short one) has no meaningful rate.
		if (ended - first >= MIN_RATE_SPAN_MS) stats.tokensPerSecond = tokens / ((ended - first) / 1000);
	}
	return stats;
}
