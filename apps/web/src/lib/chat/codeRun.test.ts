// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeCode } from '@/lib/apis/utils';
import type { BackendConfig } from '@/lib/stores/configStore';
import { codeRunner } from './codeRun';

const config = (enabled: boolean, engine?: string): BackendConfig => ({
	name: 'x',
	version: '1',
	features: { enable_code_execution: enabled },
	...(engine ? { code: { engine } } : {})
});

afterEach(() => vi.unstubAllGlobals());

describe('codeRunner', () => {
	it('runs in the chat sandbox under the sandbox engine, passing the chat id', async () => {
		const run = vi.fn(async () => ({ stdout: 'hi' }));
		const runner = codeRunner(config(true, 'sandbox'), 'tok', run);
		if (!runner) throw new Error('no runner under the sandbox engine');
		expect(await runner('print(1)', 'chat-1')).toEqual({ stdout: 'hi' });
		expect(run).toHaveBeenCalledWith('tok', 'print(1)', 'chat-1');
	});

	it('runs on Jupyter without a chat', async () => {
		const run = vi.fn(async () => ({}));
		const runner = codeRunner(config(true, 'jupyter'), 'tok', run);
		if (!runner) throw new Error('no runner under the jupyter engine');
		await runner('x', 'chat-1');
		expect(run).toHaveBeenCalledWith('tok', 'x');
	});

	it('offers no runner for Pyodide, an unknown engine, disabled code execution or no config', () => {
		expect(codeRunner(config(true, 'pyodide'), 'tok')).toBeUndefined();
		expect(codeRunner(config(true), 'tok')).toBeUndefined();
		expect(codeRunner(config(false, 'sandbox'), 'tok')).toBeUndefined();
		expect(codeRunner(null, 'tok')).toBeUndefined();
	});
});

describe('executeCode', () => {
	const stub = (status: number, body: unknown) => {
		const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
			Response.json(body, { status, headers: { 'content-type': 'application/json' } })
		);
		vi.stubGlobal('fetch', fetch);
		return fetch;
	};

	it('sends the chat id with the code when given, and only then', async () => {
		const fetch = stub(200, { stdout: 'ok' });
		expect(await executeCode('tok', 'print(1)', 'chat-1')).toEqual({ stdout: 'ok' });
		await executeCode('tok', 'print(2)');
		const [url, init] = fetch.mock.calls[0];
		expect(url).toMatch(/\/utils\/code\/execute$/);
		expect(((init?.headers ?? {}) as Record<string, string>).Authorization).toBe('Bearer tok');
		expect(JSON.parse(String(init?.body))).toEqual({ code: 'print(1)', chat_id: 'chat-1' });
		expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toEqual({ code: 'print(2)' });
	});

	it("throws the endpoint's refusal", async () => {
		stub(404, { detail: "We could not find what you're looking for :/" });
		await expect(executeCode('tok', 'x', 'chat-1')).rejects.toContain('could not find');
	});
});
