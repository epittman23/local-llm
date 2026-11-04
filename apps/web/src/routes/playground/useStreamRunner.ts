import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { chatCompletion } from '@/lib/apis/openai';
import { useAuthStore } from '@/lib/stores/authStore';
import { readCompletionStream } from './playgroundModel';

/**
 * Runs a streamed completion, with a Stop that aborts the request itself (the
 * Svelte loop only stopped between chunks). The controller exists before the
 * request starts, so Stop and leaving the page abort it while it still waits
 * for its first byte too: a slow local model can take a long time to answer
 * at all, and the request used to run on (#207).
 */
export function useStreamRunner() {
	const token = useAuthStore((s) => s.token) ?? '';
	const [running, setRunning] = useState(false);
	const controller = useRef<AbortController | null>(null);
	useEffect(() => () => controller.current?.abort(), []);
	const run = async (body: object, onText: (t: string) => void) => {
		const ctrl = new AbortController();
		controller.current = ctrl;
		setRunning(true);
		try {
			const [res] = await chatCompletion(token, body, undefined, ctrl);
			await readCompletionStream(res, onText, ctrl.signal);
		} catch (err) {
			if (!ctrl.signal.aborted) toast.error(`${err instanceof Error ? err.message : err}`);
		} finally {
			if (controller.current === ctrl) controller.current = null;
			setRunning(false);
		}
	};
	return { running, run, stop: () => controller.current?.abort('User: Stop Response') };
}
