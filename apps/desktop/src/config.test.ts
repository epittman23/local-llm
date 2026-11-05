import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	configProblem,
	DEFAULT_SERVER_URL,
	isLocalOrigin,
	isRepoRoot,
	localPort,
	normalizeServerUrl,
	parseConfig,
	relaunchArgs,
	resolveServerUrl,
	serverOverride,
	updateConfig
} from './config';

const defaults = { serverUrl: DEFAULT_SERVER_URL, repoPath: '/repo' };

describe('normalizeServerUrl', () => {
	it('reduces an http(s) URL to its origin', () => {
		expect(normalizeServerUrl(' https://llm.example.ts.net/c/abc?x=1 ')).toBe('https://llm.example.ts.net');
		expect(normalizeServerUrl('http://127.0.0.1:4000/')).toBe('http://127.0.0.1:4000');
	});

	it('refuses other schemes and garbage', () => {
		expect(normalizeServerUrl('file:///etc/passwd')).toBeNull();
		expect(normalizeServerUrl('javascript:alert(1)')).toBeNull();
		expect(normalizeServerUrl('127.0.0.1:4000')).toBeNull();
		expect(normalizeServerUrl('')).toBeNull();
	});
});

describe('isLocalOrigin', () => {
	it('is loopback only', () => {
		expect(isLocalOrigin('http://127.0.0.1:4000')).toBe(true);
		expect(isLocalOrigin('http://localhost:4000')).toBe(true);
		expect(isLocalOrigin('http://[::1]:4000')).toBe(true);
		expect(isLocalOrigin('http://192.168.1.20:4000')).toBe(false);
		expect(isLocalOrigin('https://llm.example.ts.net')).toBe(false);
	});
});

describe('localPort', () => {
	it('falls back to the scheme default', () => {
		expect(localPort('http://127.0.0.1:4000')).toBe(4000);
		expect(localPort('http://localhost')).toBe(80);
		expect(localPort('https://localhost')).toBe(443);
	});
});

describe('resolveServerUrl', () => {
	it('prefers the flag, then the environment, then the stored value', () => {
		const env = { LLLM_SERVER_URL: 'http://localhost:4100' };
		expect(resolveServerUrl(['--server-url=https://a.example'], env, 'http://127.0.0.1:4200')).toBe(
			'https://a.example'
		);
		expect(resolveServerUrl([], env, 'http://127.0.0.1:4200')).toBe('http://localhost:4100');
		expect(resolveServerUrl([], {}, 'http://127.0.0.1:4200')).toBe('http://127.0.0.1:4200');
		expect(resolveServerUrl([], {}, undefined)).toBe(DEFAULT_SERVER_URL);
	});

	it('skips a value that is not a URL', () => {
		expect(resolveServerUrl(['--server-url=nope'], {}, undefined)).toBe(DEFAULT_SERVER_URL);
	});
});

describe('isRepoRoot', () => {
	it('needs the Makefile and the backend', () => {
		const files = new Set(['/repo/Makefile', '/repo/apps/server/pyproject.toml']);
		expect(isRepoRoot('/repo', (p) => files.has(p))).toBe(true);
		expect(isRepoRoot('/elsewhere', (p) => files.has(p))).toBe(false);
	});
});

describe('parseConfig', () => {
	it('returns the defaults for a missing or broken file', () => {
		expect(parseConfig(null, defaults)).toEqual(defaults);
		expect(parseConfig('{not json', defaults)).toEqual(defaults);
		expect(parseConfig('[1, 2]', defaults)).toEqual(defaults);
	});

	it('keeps only well-formed fields', () => {
		const text = JSON.stringify({
			serverUrl: 'ftp://nope',
			repoPath: '/home/user/local-llm',
			bounds: { x: 0, y: 0, width: 'wide', height: 600 }
		});
		expect(parseConfig(text, defaults)).toEqual({ serverUrl: DEFAULT_SERVER_URL, repoPath: '/home/user/local-llm' });
	});

	it('reads a valid file', () => {
		const stored = {
			serverUrl: 'https://llm.example.ts.net/',
			repoPath: '/r',
			bounds: { x: 1, y: 2, width: 3, height: 4 }
		};
		expect(parseConfig(JSON.stringify(stored), defaults)).toEqual({
			...stored,
			serverUrl: 'https://llm.example.ts.net'
		});
	});
});

describe('serverOverride (#424)', () => {
	it('names the flag or the variable that overrides the stored setting', () => {
		const env = { LLLM_SERVER_URL: 'http://localhost:4100' };
		expect(serverOverride(['--server-url=https://a.example/x'], env)).toEqual({
			url: 'https://a.example',
			from: '--server-url'
		});
		expect(serverOverride([], env)).toEqual({ url: 'http://localhost:4100', from: 'LLLM_SERVER_URL' });
		expect(serverOverride(['--server-url=nope'], env)?.from).toBe('LLLM_SERVER_URL');
		expect(serverOverride([], {})).toBeNull();
		expect(serverOverride([], { LLLM_SERVER_URL: '' })).toBeNull();
	});

	it('leaves the flag out of a relaunch, which is another launch', () => {
		expect(relaunchArgs(['/usr/bin/electron', '.', '--server-url=https://a.example', '--no-sandbox'])).toEqual([
			'.',
			'--no-sandbox'
		]);
	});
});

describe('configProblem (#437)', () => {
	it('says when the stored server URL cannot be used, and what is used instead', () => {
		const problem = configProblem(JSON.stringify({ serverUrl: 'llm.example.ts.net' }));
		expect(problem).toContain('"llm.example.ts.net"');
		expect(problem).toContain(DEFAULT_SERVER_URL);
		expect(configProblem(JSON.stringify({ serverUrl: 42 }))).toContain('42');
	});

	it('says when the file is not a JSON object', () => {
		expect(configProblem('{not json')).toContain('not a JSON object');
		expect(configProblem('[1, 2]')).toContain('not a JSON object');
	});

	it('is null for a missing, empty or valid file', () => {
		expect(configProblem(null)).toBeNull();
		expect(configProblem('')).toBeNull();
		expect(configProblem(JSON.stringify({ serverUrl: 'https://llm.example.ts.net' }))).toBeNull();
		expect(configProblem(JSON.stringify({ repoPath: '/r' }))).toBeNull();
	});
});

describe('updateConfig (#437)', () => {
	const dir = () => mkdtempSync(join(tmpdir(), 'lllm-config-'));
	const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

	it('writes only what changed, keeping a mistyped URL and fields it does not know', () => {
		const file = join(dir(), 'config.json');
		writeFileSync(file, JSON.stringify({ serverUrl: 'llm.example.ts.net', theme: 'dark' }));
		const bounds = { x: 1, y: 2, width: 3, height: 4 };

		expect(updateConfig(file, { bounds })).toBe(true);
		expect(read(file)).toEqual({ serverUrl: 'llm.example.ts.net', theme: 'dark', bounds });
	});

	it('creates the file and its folder on the first save', () => {
		const file = join(dir(), 'Local LLM', 'config.json');
		expect(updateConfig(file, { repoPath: '/r' })).toBe(true);
		expect(read(file)).toEqual({ repoPath: '/r' });
	});

	it('leaves a file that is not a JSON object alone, unless told to replace it', () => {
		const file = join(dir(), 'config.json');
		writeFileSync(file, '{"serverUrl": "https://a.example",');

		expect(updateConfig(file, { bounds: { x: 0, y: 0, width: 9, height: 9 } })).toBe(false);
		expect(readFileSync(file, 'utf8')).toBe('{"serverUrl": "https://a.example",');

		expect(updateConfig(file, { serverUrl: 'https://b.example' }, true)).toBe(true);
		expect(read(file)).toEqual({ serverUrl: 'https://b.example' });
	});

	it('leaves a file it cannot read alone', () => {
		const file = join(dir(), 'config.json');
		mkdirSync(file); // reads fail with EISDIR, as an unreadable file's would
		expect(updateConfig(file, { repoPath: '/r' })).toBe(false);
	});

	it('throws when the file cannot be written, for the caller to report', () => {
		const file = join(dir(), 'config.json');
		mkdirSync(`${file}.tmp`); // the temporary file it writes first
		expect(() => updateConfig(file, { repoPath: '/r' }, true)).toThrow();
	});
});
