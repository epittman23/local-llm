import { describe, expect, it } from 'vitest';
import { alignKeys, normalizeConfigs, removeConnection, stripTrailingSlashes } from './connectionsList';

describe('normalizeConfigs', () => {
	it('falls back to the URL-keyed legacy entry, then to {}', () => {
		const out = normalizeConfigs(['http://a', 'http://b', 'http://c'], { 0: { enable: false }, 'http://b': { prefix_id: 'b' } });
		expect(out[0]).toEqual({ enable: false });
		expect(out[1]).toEqual({ prefix_id: 'b' });
		expect(out[2]).toEqual({});
	});
	it('does not mutate its input and tolerates null', () => {
		const input = { 'http://a': { x: 1 } };
		normalizeConfigs(['http://a'], input);
		expect(input).toEqual({ 'http://a': { x: 1 } });
		expect(normalizeConfigs(['u'], null)).toEqual({ 0: {} });
	});
});

describe('stripTrailingSlashes / alignKeys', () => {
	it('drops one trailing slash', () => {
		expect(stripTrailingSlashes(['http://a/', 'http://b'])).toEqual(['http://a', 'http://b']);
	});
	it('pads and trims keys to the URL count', () => {
		expect(alignKeys(['a', 'b', 'c'], ['k1'])).toEqual(['k1', '', '']);
		expect(alignKeys(['a'], ['k1', 'k2', 'k3'])).toEqual(['k1']);
	});
});

describe('removeConnection', () => {
	const urls = ['a', 'b', 'c'];
	const keys = ['ka', 'kb', 'kc'];
	const configs = { 0: { n: 'a' }, 1: { n: 'b' }, 2: { n: 'c' } };
	it('removes a middle entry and shifts later configs down', () => {
		const r = removeConnection(urls, keys, configs, 1);
		expect(r.urls).toEqual(['a', 'c']);
		expect(r.keys).toEqual(['ka', 'kc']);
		expect(r.configs).toEqual({ 0: { n: 'a' }, 1: { n: 'c' } });
	});
	it('removes the first and last entries', () => {
		expect(removeConnection(urls, keys, configs, 0).configs).toEqual({ 0: { n: 'b' }, 1: { n: 'c' } });
		expect(removeConnection(urls, keys, configs, 2).configs).toEqual({ 0: { n: 'a' }, 1: { n: 'b' } });
	});
	it('handles Ollama, which has no key list', () => {
		expect(removeConnection(['a', 'b'], null, { 0: { n: 'a' }, 1: { n: 'b' } }, 0)).toEqual({ urls: ['b'], keys: null, configs: { 0: { n: 'b' } } });
	});
});
