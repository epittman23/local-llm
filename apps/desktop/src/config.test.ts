import { describe, expect, it } from 'vitest';
import {
	DEFAULT_SERVER_URL,
	isLocalOrigin,
	isRepoRoot,
	localPort,
	normalizeServerUrl,
	parseConfig,
	resolveServerUrl
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
