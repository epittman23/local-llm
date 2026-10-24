// The progress dialog's model: a checklist of startup or shutdown steps,
// advanced by events from main.ts and by the `==> ` marker lines that the
// root Makefile and the backend's shutdown hook print. A pure reducer, so it
// is unit-tested against logs captured from real runs (test/fixtures/).

export type StepState = 'pending' | 'running' | 'done' | 'skipped' | 'failed';

export interface StepDef {
	id: string;
	label: string;
	/** A `==> ` line that starts this step. */
	marker?: string;
	/** A `==> ` line that finishes it. */
	endMarker?: string;
	/** Shown under the step once it has been running this long. */
	hint?: { afterMs: number; text: string };
	/** Why it was skipped, when a later step starts before it ever did. */
	skipReason?: string;
	/** Hidden unless it actually runs (the force-stop step). */
	optional?: boolean;
}

export interface Step extends StepDef {
	state: StepState;
	startedAt?: number;
	endedAt?: number;
	/** The latest output line while it runs, or why it was skipped or failed. */
	detail?: string;
}

export interface Progress {
	kind: 'startup' | 'shutdown';
	title: string;
	startedAt: number;
	endedAt?: number;
	steps: Step[];
	log: string[];
	error?: string;
	finished: boolean;
	/** A llama-server outlived a forced stop; the dialog offers to stop it. */
	offerStopLlama: boolean;
}

export type ProgressEvent =
	| { type: 'begin'; step: string; at: number; detail?: string }
	| { type: 'finish'; step: string; at: number }
	| { type: 'skip'; step: string; at: number; reason: string }
	| { type: 'timeout'; step: string; at: number }
	| { type: 'fail'; message: string; at: number; step?: string }
	| { type: 'line'; text: string; at: number }
	| { type: 'offer-stop-llama' }
	| { type: 'complete'; at: number };

export const LOG_LINES = 300;
const MARKER = '==> ';

export const STARTUP_OWN: StepDef[] = [
	{ id: 'check', label: 'Check for a running backend' },
	{
		id: 'build',
		label: 'Build the UI',
		hint: { afterMs: 30_000, text: 'A full build of the UI takes a minute or two.' }
	},
	{
		id: 'services',
		label: 'Start Postgres and Redis',
		marker: '==> Starting Postgres and Redis',
		hint: { afterMs: 30_000, text: 'Docker may be pulling images on a first run.' }
	},
	{
		id: 'sync',
		label: 'Sync the Python environment',
		marker: '==> Syncing the backend environment',
		hint: { afterMs: 20_000, text: 'First run downloads Python packages; this can take several minutes.' }
	},
	{
		id: 'backend',
		label: 'Start the backend',
		marker: '==> Starting the backend on',
		hint: { afterMs: 30_000, text: 'Loading the embedding model and running database migrations.' }
	},
	{ id: 'open', label: 'Open the app' }
];

export const STARTUP_ATTACH: StepDef[] = [
	{ id: 'check', label: 'Check for a running backend' },
	{ id: 'ready', label: 'Wait until it is ready' },
	{ id: 'open', label: 'Open the app' }
];

export function startupRemote(origin: string): StepDef[] {
	return [
		{ id: 'check', label: `Connect to ${origin}` },
		{ id: 'open', label: 'Open the app' }
	];
}

export const SHUTDOWN: StepDef[] = [
	{ id: 'window', label: 'Close the app window' },
	{ id: 'requests', label: 'Finish open requests (up to 10 s)' },
	{
		id: 'jobs',
		label: 'Stop benchmark runs',
		marker: '==> Stopping benchmark jobs',
		endMarker: '==> Stopped benchmark jobs',
		skipReason: 'none running'
	},
	{
		id: 'model',
		label: 'Stop the served model',
		marker: '==> Stopping the served model',
		endMarker: '==> Stopped the served model',
		skipReason: 'none running'
	},
	{ id: 'services', label: 'Stop Postgres and Redis', marker: '==> Stopping Postgres and Redis' },
	{ id: 'force', label: 'Force stop', optional: true }
];

export function createProgress(kind: Progress['kind'], title: string, defs: StepDef[], at: number): Progress {
	return {
		kind,
		title,
		startedAt: at,
		steps: defs.map((def) => ({ ...def, state: 'pending' })),
		log: [],
		finished: false,
		offerStopLlama: false
	};
}

/** The text a terminal would end up showing: no colour codes, the last of any \r rewrites. */
export function cleanLine(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point
	const plain = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
	return (plain.split('\r').pop() ?? '').trimEnd();
}

function update(progress: Progress, id: string, change: (step: Step) => Step): Progress {
	return { ...progress, steps: progress.steps.map((s) => (s.id === id ? change(s) : s)) };
}

/**
 * Closes everything before step `id`: a running step finished when a later
 * one began, and a pending one never had to run. This is what keeps a
 * missed marker from leaving a step spinning forever.
 */
function settleBefore(progress: Progress, id: string, at: number): Progress {
	const index = progress.steps.findIndex((s) => s.id === id);
	return {
		...progress,
		steps: progress.steps.map((s, i) => {
			if (i >= index) return s;
			if (s.state === 'running') return { ...s, state: 'done', endedAt: at };
			if (s.state === 'pending') return { ...s, state: 'skipped', detail: s.optional ? undefined : s.skipReason };
			return s;
		})
	};
}

function begin(progress: Progress, id: string, at: number, detail?: string): Progress {
	const step = progress.steps.find((s) => s.id === id);
	if (step?.state !== 'pending') return progress;
	return update(settleBefore(progress, id, at), id, (s) => ({ ...s, state: 'running', startedAt: at, detail }));
}

function finish(progress: Progress, id: string, at: number): Progress {
	const step = progress.steps.find((s) => s.id === id);
	if (!step || (step.state !== 'pending' && step.state !== 'running')) return progress;
	return update(settleBefore(progress, id, at), id, (s) => ({
		...s,
		state: 'done',
		startedAt: s.startedAt ?? at,
		endedAt: at
	}));
}

function onLine(progress: Progress, raw: string, at: number): Progress {
	const text = cleanLine(raw);
	if (!text) return progress;
	let next: Progress = { ...progress, log: [...progress.log, text].slice(-LOG_LINES) };
	const markerAt = text.indexOf(MARKER);
	if (markerAt >= 0) {
		const marker = text.slice(markerAt);
		for (const step of next.steps) {
			if (step.marker && marker.startsWith(step.marker)) next = begin(next, step.id, at);
			else if (step.endMarker && marker.startsWith(step.endMarker)) next = finish(next, step.id, at);
		}
		return next;
	}
	const running = next.steps.find((s) => s.state === 'running');
	return running ? update(next, running.id, (s) => ({ ...s, detail: text.slice(0, 200) })) : next;
}

export function reduce(progress: Progress, event: ProgressEvent): Progress {
	switch (event.type) {
		case 'begin':
			return begin(progress, event.step, event.at, event.detail);
		case 'finish':
			return finish(progress, event.step, event.at);
		case 'skip':
			return update(progress, event.step, (s) =>
				s.state === 'pending' ? { ...s, state: 'skipped', detail: event.reason } : s
			);
		case 'timeout':
			return update(progress, event.step, (s) => ({
				...s,
				state: 'failed',
				endedAt: event.at,
				detail: 'did not finish in time'
			}));
		case 'fail': {
			const target =
				progress.steps.find((s) => s.id === event.step) ??
				progress.steps.find((s) => s.state === 'running') ??
				progress.steps.find((s) => s.state === 'pending');
			const failed = target
				? update(progress, target.id, (s) => ({
						...s,
						state: 'failed',
						startedAt: s.startedAt ?? event.at,
						endedAt: event.at
					}))
				: progress;
			return { ...failed, error: event.message, endedAt: event.at };
		}
		case 'line':
			return onLine(progress, event.text, event.at);
		case 'offer-stop-llama':
			return { ...progress, offerStopLlama: true };
		case 'complete':
			return {
				...progress,
				finished: true,
				endedAt: event.at,
				steps: progress.steps.map((s) => (s.state === 'running' ? { ...s, state: 'done', endedAt: event.at } : s))
			};
	}
}
