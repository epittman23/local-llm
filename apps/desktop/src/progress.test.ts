import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	cleanLine,
	createProgress,
	LOG_LINES,
	type Progress,
	type ProgressEvent,
	reduce,
	SHUTDOWN,
	STARTUP_OWN
} from './progress';

const fixture = (name: string) => readFileSync(join(__dirname, '..', 'test', 'fixtures', name), 'utf8').split('\n');

function run(progress: Progress, events: ProgressEvent[]): Progress {
	return events.reduce(reduce, progress);
}

function feed(progress: Progress, lines: string[], at = 1000): Progress {
	return run(
		progress,
		lines.map((text, i) => ({ type: 'line', text, at: at + i }))
	);
}

const states = (p: Progress) => Object.fromEntries(p.steps.map((s) => [s.id, s.state]));

describe('startup', () => {
	it('follows a real start through every step', () => {
		let p = createProgress('startup', 'Starting Local LLM', STARTUP_OWN, 0);
		p = run(p, [
			{ type: 'begin', step: 'check', at: 1 },
			{ type: 'finish', step: 'check', at: 2 },
			{ type: 'skip', step: 'build', reason: 'up to date', at: 3 }
		]);
		p = feed(p, fixture('start.log'));
		expect(states(p)).toMatchObject({
			check: 'done',
			build: 'skipped',
			services: 'done',
			sync: 'done',
			backend: 'running'
		});
		expect(p.steps.find((s) => s.id === 'build')?.detail).toBe('up to date');
		// The running step shows the latest output line.
		expect(p.steps.find((s) => s.id === 'backend')?.detail).toContain('GET /ready');

		p = run(p, [
			{ type: 'finish', step: 'backend', at: 9000 },
			{ type: 'begin', step: 'open', at: 9001 },
			{ type: 'complete', at: 9500 }
		]);
		expect(states(p)).toMatchObject({ backend: 'done', open: 'done' });
		expect(p.finished).toBe(true);
	});

	it('shows the Makefile’s own message when make backend fails', () => {
		let p = createProgress('startup', 'Starting Local LLM', STARTUP_OWN, 0);
		p = run(p, [
			{ type: 'finish', step: 'check', at: 1 },
			{ type: 'skip', step: 'build', reason: 'up to date', at: 2 }
		]);
		p = feed(p, fixture('failed-start.log'));
		p = reduce(p, { type: 'fail', message: 'make backend stopped (exit code 2)', at: 50 });
		expect(p.error).toBe('make backend stopped (exit code 2)');
		expect(states(p).services).toBe('failed');
		expect(p.log.join('\n')).toContain('infra/.env not found');
	});
});

describe('shutdown', () => {
	const begin = () =>
		run(createProgress('shutdown', 'Stopping Local LLM', SHUTDOWN, 0), [
			{ type: 'begin', step: 'window', at: 1 },
			{ type: 'begin', step: 'requests', at: 2 }
		]);

	it('skips the job steps when nothing was running', () => {
		const p = reduce(feed(begin(), fixture('shutdown-idle.log')), { type: 'complete', at: 9000 });
		expect(states(p)).toEqual({
			window: 'done',
			requests: 'done',
			jobs: 'skipped',
			model: 'skipped',
			services: 'done',
			force: 'pending'
		});
		expect(p.steps.find((s) => s.id === 'model')?.detail).toBe('none running');
		// The optional force step stays silent.
		expect(p.steps.find((s) => s.id === 'force')?.detail).toBeUndefined();
	});

	it('follows the output while uvicorn cancels a held request', () => {
		const lines = fixture('shutdown-stalled-request.log');
		const p = feed(begin(), lines.slice(0, lines.indexOf('==> Stopping Postgres and Redis')));
		const requests = p.steps.find((s) => s.id === 'requests');
		expect(requests?.state).toBe('running');
		// The cancelled request's own access line, after uvicorn's traceback for it.
		expect(requests?.detail).toContain('"POST /api/v1/auths/signin HTTP/1.1" 500');
		expect(p.log).toContain('Cancel 1 running task(s), timeout graceful shutdown exceeded');
	});

	it('marks the jobs and the served model done when the backend stopped them', () => {
		const p = reduce(feed(begin(), fixture('shutdown-with-jobs.synthetic.log')), { type: 'complete', at: 9000 });
		expect(states(p)).toMatchObject({ requests: 'done', jobs: 'done', model: 'done', services: 'done' });
	});

	it('shows a forced stop', () => {
		let p = feed(begin(), ['==> Stopping Postgres and Redis']);
		p = run(p, [
			{ type: 'timeout', step: 'services', at: 90_000 },
			{ type: 'begin', step: 'force', at: 90_001 },
			{ type: 'offer-stop-llama' },
			{ type: 'complete', at: 95_000 }
		]);
		expect(states(p)).toMatchObject({ services: 'failed', force: 'done' });
		expect(p.offerStopLlama).toBe(true);
	});
});

describe('lines', () => {
	it('keeps the last LOG_LINES of output', () => {
		const lines = Array.from({ length: LOG_LINES + 50 }, (_, i) => `line ${i}`);
		const p = feed(createProgress('startup', 't', STARTUP_OWN, 0), lines);
		expect(p.log).toHaveLength(LOG_LINES);
		expect(p.log.at(-1)).toBe(`line ${LOG_LINES + 49}`);
	});

	it('strips colour codes and keeps the last carriage-return rewrite', () => {
		expect(cleanLine('\x1b[32mResolved\x1b[0m 12 packages')).toBe('Resolved 12 packages');
		expect(cleanLine('Loading 10%\rLoading 100%  ')).toBe('Loading 100%');
	});

	it('matches the longer service lines make backend prints since Jupyter and SearXNG joined', () => {
		let p = feed(createProgress('startup', 't', STARTUP_OWN, 0), [
			'==> Starting Postgres and Redis, Jupyter and SearXNG'
		]);
		expect(states(p)).toMatchObject({ services: 'running' });
		p = feed(createProgress('shutdown', 't', SHUTDOWN, 0), ['==> Stopping Postgres and Redis, Jupyter and SearXNG']);
		expect(states(p)).toMatchObject({ services: 'running' });
	});

	it('never moves a finished step back', () => {
		let p = createProgress('startup', 't', STARTUP_OWN, 0);
		p = feed(p, ['==> Starting the backend on 127.0.0.1:4000', '==> Starting Postgres and Redis']);
		expect(states(p)).toMatchObject({ services: 'skipped', backend: 'running' });
	});
});
