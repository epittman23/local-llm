import { describe, expect, it } from 'vitest';
import {
	LOADER_ENGINES,
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
	it('names DDGS and SERPHouse as the UI does, others as they are', () => {
		expect(engineLabel('duckduckgo')).toBe('DDGS');
		expect(engineLabel('serphouse')).toBe('SERPHouse');
		expect(engineLabel('brave')).toBe('brave');
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
