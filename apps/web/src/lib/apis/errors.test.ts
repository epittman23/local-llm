// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorBody, errorDetail, isAbort, isServerUnreachable, requestError, ServerUnreachableError } from './errors';

const htmlBadGateway = () =>
	new Response('<html><body><h1>502 Bad Gateway</h1>nginx</body></html>', {
		status: 502,
		statusText: 'Bad Gateway',
		headers: { 'Content-Type': 'text/html' }
	});

afterEach(() => vi.unstubAllGlobals());

describe('errorBody', () => {
	it('returns a JSON error body as the server sent it', async () => {
		const res = new Response(JSON.stringify({ detail: 'Not allowed' }), { status: 403 });
		expect(await errorBody(res)).toEqual({ detail: 'Not allowed' });
	});

	it('gives a non-JSON body a readable detail with the status', async () => {
		const body = (await errorBody(htmlBadGateway())) as { detail: string };
		expect(body.detail).toBe('502 Bad Gateway: nginx');
	});

	it('gives an empty body its status', async () => {
		expect(await errorBody(new Response('', { status: 500, statusText: 'Internal Server Error' }))).toEqual({
			detail: '500 Internal Server Error'
		});
	});
});

describe('errorDetail and requestError', () => {
	it('turns a network failure into ServerUnreachableError, which reads as a sentence', () => {
		const err = errorDetail(new TypeError('Failed to fetch'));
		expect(isServerUnreachable(err)).toBe(true);
		expect(`${err}`).toBe('Could not reach the server');
		expect(isServerUnreachable(requestError(new TypeError('Load failed')))).toBe(true);
	});

	it('passes an abort through for callers to ignore', () => {
		const abort = new DOMException('The user aborted a request.', 'AbortError');
		expect(errorDetail(abort)).toBe(abort);
		expect(isAbort(errorDetail(abort))).toBe(true);
	});

	it("uses the body's detail, joining FastAPI's validation list", () => {
		expect(errorDetail({ detail: 'Not allowed' })).toBe('Not allowed');
		expect(errorDetail({ detail: [{ msg: 'field required' }, { msg: 'too long' }] })).toBe('field required, too long');
	});

	it('is never falsy, so `if (error) throw error` always throws', () => {
		for (const err of [undefined, null, {}, { detail: '' }, new SyntaxError('Unexpected token')]) {
			expect(errorDetail(err)).toBeTruthy();
			expect(requestError(err)).toBeTruthy();
		}
	});

	it('keeps an error body object as an object for requestError callers', () => {
		const body = { detail: 'Not allowed', code: 7 };
		expect(requestError(body)).toBe(body);
		expect(requestError(new TypeError('x'))).toBeInstanceOf(ServerUnreachableError);
	});
});

/**
 * Every helper in lib/apis, against a fetch that fails (#240): they used to
 * resolve null on a network failure or a non-JSON error body, so callers
 * reported success or lost the failure.
 */
describe('every API helper rejects on a failed request', () => {
	const modules = import.meta.glob('/src/lib/apis/**/index.ts', { eager: true }) as Record<
		string,
		Record<string, unknown>
	>;

	// Helpers that take structured arguments; the rest get a placeholder string for each.
	const ARGS: Record<string, unknown[]> = {
		'benchmarks.getCompare': ['t', { by: 'config' }],
		'benchmarks.getAnswerOne': ['t', { run: 'r', benchmark: 'b', item_id: 'i' }],
		'calendar.getCalendarEvents': ['t', '2026-10-01', '2026-10-31', ['c']],
		'prompts.createNewPrompt': ['t', { command: 'x', name: 'x', content: 'x' }],
		'openai.verifyOpenAIConnection': ['t', { url: 'http://provider.test/v1', key: 'k' }]
	};

	// Helpers that do not reject on a failed request, on purpose. Each says why.
	const ALLOWED: Record<string, string> = {
		// No request, or no request with these arguments.
		'auths.getLogoutRedirectUrl': 'builds a URL',
		'benchmarks.parseBenchmarksEventStream': 'parses a stream it is given',
		'benchmarks.reportFileUrl': 'builds a URL',
		'configs.getOAuthClientAuthorizationUrl': 'builds a URL',
		'configs.initiateOAuthRedirect': 'navigates the page',
		'openai.getErrorMessage': 'formats an error',
		'users.getAndUpdateUserLocation': 'asks for the location first, and gives up quietly without it',
		'streaming.createOpenAITextStream': 'reads a response body it is given',
		'index.getToolServersData': "collects each tool server's error in its result",
		'index.executeToolServer': "returns a tool call's error as the tool's result",
		// Stream openers: they return the Response, and the caller checks res.ok.
		'benchmarks.streamServe': 'returns the response',
		'benchmarks.streamTestRun': 'returns the response',
		'benchmarks.streamTuneLog': 'returns the response',
		'files.getFileProcessStatus': 'returns the response',
		'index.generateMoACompletion': 'returns the response',
		'ollama.createModel': 'returns the response',
		'ollama.downloadModel': 'returns the response',
		'ollama.generateChatCompletion': 'returns the response',
		'ollama.generateEmbeddings': 'returns the response',
		'ollama.generateTextCompletion': 'returns the response',
		'ollama.pullModel': 'returns the response',
		'ollama.unloadModel': 'returns the response',
		'ollama.uploadModel': 'returns the response',
		'openai.chatCompletion': 'returns the response',
		'openai.synthesizeOpenAISpeech': 'returns the response',
		'knowledge.streamPendingKnowledgeFiles': 'rejects with its own message, without the status',
		// Best effort: a background extra whose failure the user should not see.
		'auths.updateUserTimezone': 'best effort, on sign-in',
		'index.generateAutoCompletion': 'best effort, while typing',
		'index.generateEmoji': 'best effort, decoration',
		'index.generateQueries': 'best effort, retrieval falls back to the prompt',
		'index.generateTags': 'best effort, background task',
		'index.generateTitle': 'best effort, background task',
		'ollama.generatePrompt': 'best effort, autocomplete',
		'configs.detectTerminalServerType': 'a probe: null means unknown'
	};

	// Whole modules with their own convention.
	const ALLOWED_MODULES: Record<string, string> = {
		terminal: 'talks to a separate terminal server: null means it is unavailable, and callers show that'
	};

	const helpers = Object.entries(modules).flatMap(([path, mod]) => {
		const module = path.replace('/src/lib/apis/', '').replace(/\/?index\.ts$/, '') || 'index';
		if (module in ALLOWED_MODULES) return [];
		return Object.entries(mod)
			.filter(([, fn]) => typeof fn === 'function' && !/^[A-Z]/.test(fn.name))
			.map(([name, fn]) => ({ key: `${module}.${name}`, fn: fn as (...a: unknown[]) => unknown }));
	});

	const call = async ({ key, fn }: (typeof helpers)[number]) => {
		const args = ARGS[key] ?? Array.from({ length: Math.max(fn.length, 1) }, () => 'x');
		return Promise.race([
			Promise.resolve().then(() => fn(...args)),
			new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 1000))
		]).then(
			(value) => ({ rejected: false as const, value }),
			(reason) => ({ rejected: true as const, reason })
		);
	};

	const text = (reason: unknown) =>
		typeof reason === 'string' ? reason : String((reason as { detail?: unknown })?.detail ?? reason);

	it('covers every helper with a real request', () => {
		expect(helpers.length).toBeGreaterThan(300);
		const unknown = Object.keys({ ...ALLOWED, ...ARGS }).filter((k) => !helpers.some((h) => h.key === k));
		expect(unknown).toEqual([]);
	});

	it('rejects, readably, when the server cannot be reached', async () => {
		const wrong: string[] = [];
		for (const h of helpers) {
			if (h.key in ALLOWED) continue;
			const fetch = vi.fn(async () => {
				throw new TypeError('Failed to fetch');
			});
			vi.stubGlobal('fetch', fetch);
			const out = await call(h);
			const reason = out.rejected ? out.reason : undefined;
			const readable =
				isServerUnreachable(reason) || (typeof reason === 'string' && reason !== '') || reason instanceof Error;
			if (!out.rejected || !readable || fetch.mock.calls.length === 0)
				wrong.push(`${h.key}: ${out.rejected ? text(reason) : 'resolved'}`);
			vi.unstubAllGlobals();
		}
		expect(wrong).toEqual([]);
	}, 60_000);

	it('rejects with the status when the error body is not JSON', async () => {
		const wrong: string[] = [];
		for (const h of helpers) {
			if (h.key in ALLOWED) continue;
			const fetch = vi.fn(async () => htmlBadGateway());
			vi.stubGlobal('fetch', fetch);
			const out = await call(h);
			if (!out.rejected || !text(out.reason).includes('502') || fetch.mock.calls.length === 0)
				wrong.push(`${h.key}: ${out.rejected ? text(out.reason) : 'resolved'}`);
			vi.unstubAllGlobals();
		}
		expect(wrong).toEqual([]);
	}, 60_000);
});
