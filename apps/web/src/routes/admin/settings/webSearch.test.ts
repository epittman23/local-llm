import { describe, expect, it } from 'vitest';
import {
	BUNDLED_SEARXNG_URL,
	bundledSearxngPrefill,
	LOADER_ENGINES,
	loaderLabel,
	SEARCH_ENGINE_ORDER,
	SEARCH_ENGINES,
	SEARCH_ENGINE_FIELDS,
	engineLabel,
	isDefaultLoader,
	loaderFields,
	prepareWebConfig,
	toWebForm
} from './webSearch';

describe('engine tables', () => {
	it('every listed search engine has its settings, except the one whose only control is the DDGS backend', () => {
		const missing = SEARCH_ENGINES.filter((e) => !(e in SEARCH_ENGINE_FIELDS));
		expect(missing).toEqual(['duckduckgo']);
	});
	it('no engine lists the same setting twice, and every field has a label', () => {
		for (const [engine, fields] of Object.entries(SEARCH_ENGINE_FIELDS)) {
			const names = fields.map((f) => f.name);
			expect(new Set(names).size, engine).toBe(names.length);
			for (const f of fields) expect(f.label, `${engine}.${f.name}`).toBeTruthy();
		}
	});
	it('names each engine as its makers write it (#1025)', () => {
		expect(engineLabel('duckduckgo')).toBe('DDGS');
		expect(engineLabel('serphouse')).toBe('SERPHouse');
		expect(engineLabel('brave')).toBe('Brave Search');
		expect(engineLabel('searxng')).toBe('SearXNG (bundled)');
		expect(engineLabel('unknown_engine')).toBe('unknown_engine');
		for (const e of SEARCH_ENGINES) expect(engineLabel(e), e).not.toBe(e);
		expect(loaderLabel('external')).toBe('External loader server');
		expect(loaderLabel('playwright')).toBe('Playwright');
	});
	it('offers the bundled SearXNG first, then the rest by name', () => {
		expect(SEARCH_ENGINE_ORDER[0]).toBe('searxng');
		expect([...SEARCH_ENGINE_ORDER].sort()).toEqual([...SEARCH_ENGINES].sort());
		const rest = SEARCH_ENGINE_ORDER.slice(1).map(engineLabel);
		expect(rest).toEqual([...rest].sort((a, b) => a.localeCompare(b)));
	});
});

describe('bundledSearxngPrefill (S5-D6)', () => {
	it('preselects SearXNG and fills its address and language when no engine is stored', () => {
		expect(bundledSearxngPrefill({ WEB_SEARCH_ENGINE: '', SEARXNG_QUERY_URL: '', SEARXNG_LANGUAGE: '' })).toEqual({
			WEB_SEARCH_ENGINE: 'searxng',
			SEARXNG_QUERY_URL: BUNDLED_SEARXNG_URL,
			SEARXNG_LANGUAGE: 'all'
		});
		expect(BUNDLED_SEARXNG_URL).toBe('http://127.0.0.1:8080/search?q=<query>');
	});
	it('never replaces a stored address or language, and leaves a stored engine alone', () => {
		expect(
			bundledSearxngPrefill({
				WEB_SEARCH_ENGINE: null,
				SEARXNG_QUERY_URL: 'http://searx/search',
				SEARXNG_LANGUAGE: 'en'
			})
		).toEqual({ WEB_SEARCH_ENGINE: 'searxng' });
		expect(bundledSearxngPrefill({ WEB_SEARCH_ENGINE: 'brave' })).toBeNull();
	});
});

describe('loaderFields', () => {
	const names = (loader: string, search: string) => loaderFields(loader, search).map((f) => f.name);
	it('asks each loader for its own settings', () => {
		expect(names('playwright', '')).toEqual(['PLAYWRIGHT_WS_URL', 'PLAYWRIGHT_TIMEOUT']);
		expect(names('external', '')).toEqual(['EXTERNAL_WEB_LOADER_URL', 'EXTERNAL_WEB_LOADER_API_KEY']);
		expect(names('tavily', 'brave')).toEqual(['TAVILY_EXTRACT_DEPTH', 'TAVILY_API_KEY']);
		expect(names('firecrawl', 'brave')).toEqual(['FIRECRAWL_API_BASE_URL', 'FIRECRAWL_API_KEY']);
		expect(names('microsoft_web_iq', 'brave')).toHaveLength(3);
	});
	it('does not ask twice for a connection the chosen search engine already has', () => {
		expect(names('firecrawl', 'firecrawl')).toEqual([]);
		expect(names('tavily', 'tavily')).toEqual(['TAVILY_EXTRACT_DEPTH']);
		expect(names('microsoft_web_iq', 'microsoft_web_iq')).toEqual([]);
	});
	it('the default loader and unknown ones have none of these', () => {
		expect(names('', '')).toEqual([]);
		expect(names('nonsense', '')).toEqual([]);
		expect(LOADER_ENGINES).toContain('playwright');
	});
	it('knows the default loader by either name', () => {
		expect(isDefaultLoader('')).toBe(true);
		expect(isDefaultLoader('safe_web')).toBe(true);
		expect(isDefaultLoader('playwright')).toBe(false);
	});
});

describe('toWebForm', () => {
	it('shows lists as text, numeric timeouts as numbers, and Linkup params as JSON', () => {
		const f = toWebForm({
			WEB_SEARCH_DOMAIN_FILTER_LIST: ['a.com', '!b.com'],
			YOUTUBE_LOADER_LANGUAGE: ['en', 'de'],
			FIRECRAWL_TIMEOUT: '30',
			PLAYWRIGHT_TIMEOUT: '',
			LINKUP_SEARCH_PARAMS: { depth: 'deep' },
			KEEP: 1
		});
		expect(f.WEB_SEARCH_DOMAIN_FILTER_LIST).toBe('a.com, !b.com');
		expect(f.YOUTUBE_LOADER_LANGUAGE).toBe('en, de');
		expect(f.FIRECRAWL_TIMEOUT).toBe(30);
		expect(f.PLAYWRIGHT_TIMEOUT).toBe('');
		expect(f.LINKUP_SEARCH_PARAMS).toBe('{\n  "depth": "deep"\n}');
		expect(f.KEEP).toBe(1);
	});
	it('copes with missing values', () => {
		const f = toWebForm({});
		expect(f.WEB_SEARCH_DOMAIN_FILTER_LIST).toBe('');
		expect(f.YOUTUBE_LOADER_LANGUAGE).toBe('');
		expect(f.LINKUP_SEARCH_PARAMS).toBe('');
	});
	it('leaves a timeout that is not a number alone', () => {
		expect(toWebForm({ FIRECRAWL_TIMEOUT: 'soon' }).FIRECRAWL_TIMEOUT).toBe('soon');
		expect(toWebForm({ FIRECRAWL_TIMEOUT: null }).FIRECRAWL_TIMEOUT).toBeNull();
	});
});

describe('prepareWebConfig', () => {
	it('sends only the web block, with lists split and trimmed and timeouts as strings', () => {
		const r = prepareWebConfig({
			WEB_SEARCH_DOMAIN_FILTER_LIST: ' a.com, ,!b.com ',
			YOUTUBE_LOADER_LANGUAGE: '',
			FIRECRAWL_TIMEOUT: 30,
			PLAYWRIGHT_TIMEOUT: 5000,
			LINKUP_SEARCH_PARAMS: '',
			ENABLE_WEB_SEARCH: true
		});
		expect(r).toEqual({
			ok: true,
			payload: {
				web: {
					WEB_SEARCH_DOMAIN_FILTER_LIST: ['a.com', '!b.com'],
					YOUTUBE_LOADER_LANGUAGE: [],
					FIRECRAWL_TIMEOUT: '30',
					PLAYWRIGHT_TIMEOUT: '5000',
					LINKUP_SEARCH_PARAMS: {},
					ENABLE_WEB_SEARCH: true
				}
			}
		});
	});
	it('leaves a cleared timeout as it is', () => {
		const r = prepareWebConfig({ FIRECRAWL_TIMEOUT: null, PLAYWRIGHT_TIMEOUT: '' });
		expect(r.ok && r.payload.web.FIRECRAWL_TIMEOUT).toBeNull();
		expect(r.ok && r.payload.web.PLAYWRIGHT_TIMEOUT).toBe('');
	});
	it('parses Linkup params, and refuses anything that is not a JSON object', () => {
		const ok = prepareWebConfig({ LINKUP_SEARCH_PARAMS: '{"depth":"standard"}' });
		expect(ok.ok && ok.payload.web.LINKUP_SEARCH_PARAMS).toEqual({ depth: 'standard' });
		for (const bad of ['{depth', '[1]', '"x"', 'null'])
			expect(prepareWebConfig({ LINKUP_SEARCH_PARAMS: bad })).toEqual({
				ok: false,
				error: 'Invalid JSON format in Linkup Parameters'
			});
	});
});
