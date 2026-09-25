type Rec = Record<string, any>;

export const SEARCH_ENGINES = [
	'ollama_cloud',
	'perplexity_search',
	'searxng',
	'yacy',
	'google_pse',
	'brave',
	'brave_llm_context',
	'kagi',
	'mojeek',
	'bocha',
	'serpstack',
	'serper',
	'serphouse',
	'serply',
	'searchapi',
	'serpapi',
	'duckduckgo',
	'tavily',
	'jina',
	'bing',
	'exa',
	'perplexity',
	'microsoft_web_iq',
	'sougou',
	'firecrawl',
	'external',
	'yandex',
	'youcom',
	'linkup',
	'openserp'
] as const;

export const LOADER_ENGINES = ['playwright', 'firecrawl', 'tavily', 'microsoft_web_iq', 'external'] as const;

export const engineLabel = (engine: string): string => (engine === 'duckduckgo' ? 'DDGS' : engine === 'serphouse' ? 'SERPHouse' : engine);

/** One box of an engine's settings: `name` is the key of the web config it edits. */
export type FieldSpec = {
	name: string;
	label: string;
	kind: 'text' | 'secret' | 'number' | 'textarea';
	placeholder?: string;
	required?: boolean;
	min?: number;
	max?: number;
	step?: number;
	tip?: string;
};

const text = (name: string, label: string, placeholder?: string, extra: Partial<FieldSpec> = {}): FieldSpec => ({ name, label, kind: 'text', placeholder, ...extra });
const secret = (name: string, label: string): FieldSpec => ({ name, label, kind: 'secret', placeholder: `Enter ${label}` });

const YANDEX_CONFIG_HINT = 'Leave empty to use the default config, or enter a valid json (see https://yandex.cloud/en/docs/search-api/api-ref/WebSearch/search#yandex.cloud.searchapi.v2.WebSearchRequest)';

/**
 * The connection settings of each search engine, in the order they are shown.
 * Two engines have controls this vocabulary cannot say and get them in the tab
 * itself: `perplexity` (a model list and a context-usage select) and
 * `duckduckgo` (the DDGS backend select).
 */
export const SEARCH_ENGINE_FIELDS: Record<string, FieldSpec[]> = {
	ollama_cloud: [secret('OLLAMA_CLOUD_WEB_SEARCH_API_KEY', 'Ollama Cloud API Key')],
	perplexity_search: [text('PERPLEXITY_SEARCH_API_URL', 'Perplexity Search API URL', 'Enter Perplexity Search API URL'), secret('PERPLEXITY_API_KEY', 'Perplexity API Key')],
	searxng: [
		text('SEARXNG_QUERY_URL', 'Searxng Query URL', 'Enter Searxng Query URL', { required: true }),
		text('SEARXNG_LANGUAGE', 'Searxng search language (all, en, es, de, fr, etc.)', 'Enter Searxng search language', { required: true })
	],
	yacy: [
		text('YACY_QUERY_URL', 'Yacy Instance URL', 'Enter Yacy URL (e.g. http://yacy.example.com:8090)'),
		text('YACY_USERNAME', 'Yacy Username', 'Enter Yacy Username', { required: true }),
		secret('YACY_PASSWORD', 'Yacy Password')
	],
	google_pse: [secret('GOOGLE_PSE_API_KEY', 'Google PSE API Key'), text('GOOGLE_PSE_ENGINE_ID', 'Google PSE Engine Id', 'Enter Google PSE Engine Id')],
	brave: [secret('BRAVE_SEARCH_API_KEY', 'Brave Search API Key')],
	brave_llm_context: [
		secret('BRAVE_SEARCH_API_KEY', 'Brave Search API Key'),
		{ name: 'BRAVE_SEARCH_CONTEXT_TOKENS', label: 'Context Tokens', kind: 'number', placeholder: 'Max tokens to retrieve (1024-32768, default 8192)', min: 1024, max: 32768, step: 1024 }
	],
	kagi: [secret('KAGI_SEARCH_API_KEY', 'Kagi Search API Key')],
	mojeek: [secret('MOJEEK_SEARCH_API_KEY', 'Mojeek Search API Key')],
	bocha: [secret('BOCHA_SEARCH_API_KEY', 'Bocha Search API Key')],
	serpstack: [secret('SERPSTACK_API_KEY', 'Serpstack API Key')],
	serper: [secret('SERPER_API_KEY', 'Serper API Key')],
	serphouse: [secret('SERPHOUSE_API_KEY', 'SERPHouse API Key'), text('SERPHOUSE_DOMAIN', 'SERPHouse Domain', 'google.com')],
	serply: [secret('SERPLY_API_KEY', 'Serply API Key')],
	tavily: [secret('TAVILY_API_KEY', 'Tavily API Key')],
	searchapi: [secret('SEARCHAPI_API_KEY', 'SearchApi API Key'), text('SEARCHAPI_ENGINE', 'SearchApi Engine', 'Enter SearchApi Engine')],
	serpapi: [secret('SERPAPI_API_KEY', 'SerpApi API Key'), text('SERPAPI_ENGINE', 'SerpApi Engine', 'Enter SerpApi Engine')],
	jina: [text('JINA_API_BASE_URL', 'Jina API Base URL', 'Enter Jina API Base URL'), secret('JINA_API_KEY', 'Jina API Key')],
	bing: [text('BING_SEARCH_V7_ENDPOINT', 'Bing Search V7 Endpoint', 'Enter Bing Search V7 Endpoint'), secret('BING_SEARCH_V7_SUBSCRIPTION_KEY', 'Bing Search V7 Subscription Key')],
	exa: [secret('EXA_API_KEY', 'Exa API Key')],
	perplexity: [secret('PERPLEXITY_API_KEY', 'Perplexity API Key')],
	microsoft_web_iq: [
		text('MICROSOFT_WEB_IQ_API_BASE_URL', 'Microsoft Web IQ API Base URL', 'Enter Microsoft Web IQ API Base URL'),
		secret('MICROSOFT_WEB_IQ_API_KEY', 'Microsoft Web IQ API Key'),
		text('MICROSOFT_WEB_IQ_LANGUAGE', 'Language', 'Enter language')
	],
	sougou: [secret('SOUGOU_API_SID', 'Sougou Search API sID'), secret('SOUGOU_API_SK', 'Sougou Search API SK')],
	firecrawl: [
		text('FIRECRAWL_API_BASE_URL', 'Firecrawl API Base URL', 'Enter Firecrawl API Base URL'),
		secret('FIRECRAWL_API_KEY', 'Firecrawl API Key'),
		{ name: 'FIRECRAWL_TIMEOUT', label: 'Firecrawl Timeout (s)', kind: 'number', placeholder: 'Enter Firecrawl Timeout' }
	],
	external: [text('EXTERNAL_WEB_SEARCH_URL', 'External Web Search URL', 'Enter External Web Search URL'), secret('EXTERNAL_WEB_SEARCH_API_KEY', 'External Web Search API Key')],
	yandex: [
		text('YANDEX_WEB_SEARCH_URL', 'Yandex Web Search URL', 'Enter Yandex Web Search URL'),
		secret('YANDEX_WEB_SEARCH_API_KEY', 'Yandex Web Search API Key'),
		{ name: 'YANDEX_WEB_SEARCH_CONFIG', label: 'Yandex Web Search config', kind: 'textarea', placeholder: YANDEX_CONFIG_HINT, tip: YANDEX_CONFIG_HINT }
	],
	youcom: [secret('YOUCOM_API_KEY', 'You.com API Key')],
	linkup: [
		secret('LINKUP_API_KEY', 'Linkup API Key'),
		{ name: 'LINKUP_SEARCH_PARAMS', label: 'Parameters', kind: 'textarea', placeholder: `{\n  "depth": "standard",\n  "outputType": "sourcedAnswer"\n}` }
	],
	openserp: [text('OPENSERP_BASE_URL', 'OpenSERP URL', 'Enter OpenSERP Base URL', { required: true })]
};

/**
 * What the chosen web loader needs besides the shared settings. A loader that
 * is also the chosen search engine already has its connection in that engine's
 * block, so it is not asked twice.
 */
export function loaderFields(loader: string, searchEngine: string): FieldSpec[] {
	switch (loader) {
		case 'playwright':
			return [
				text('PLAYWRIGHT_WS_URL', 'Playwright WebSocket URL', 'Enter Playwright WebSocket URL'),
				{ name: 'PLAYWRIGHT_TIMEOUT', label: 'Playwright Timeout (ms)', kind: 'number', placeholder: 'Enter Playwright Timeout' }
			];
		case 'firecrawl':
			return searchEngine === 'firecrawl' ? [] : [text('FIRECRAWL_API_BASE_URL', 'Firecrawl API Base URL', 'Enter Firecrawl API Base URL'), secret('FIRECRAWL_API_KEY', 'Firecrawl API Key')];
		case 'tavily':
			return [text('TAVILY_EXTRACT_DEPTH', 'Tavily Extract Depth', 'Enter Tavily Extract Depth'), ...(searchEngine === 'tavily' ? [] : [secret('TAVILY_API_KEY', 'Tavily API Key')])];
		case 'microsoft_web_iq':
			return searchEngine === 'microsoft_web_iq' ? [] : SEARCH_ENGINE_FIELDS.microsoft_web_iq;
		case 'external':
			return [text('EXTERNAL_WEB_LOADER_URL', 'External Web Loader URL', 'Enter External Web Loader URL'), secret('EXTERNAL_WEB_LOADER_API_KEY', 'External Web Loader API Key')];
		default:
			return [];
	}
}

/** The default loader (and the legacy `safe_web` name for it) has its own timeout and SSL switch. */
export const isDefaultLoader = (loader: string | null | undefined) => loader === '' || loader === 'safe_web';

const joinList = (value: unknown): string => (Array.isArray(value) ? value.join(', ') : typeof value === 'string' ? value : '');
const splitList = (value: unknown): string[] =>
	typeof value === 'string'
		? value
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean)
		: Array.isArray(value)
			? value
			: [];

const numberOrKeep = (value: unknown) => {
	if (typeof value === 'string' && value) {
		const n = parseInt(value, 10);
		if (!Number.isNaN(n)) return n;
	}
	return value;
};

/** The web settings as the form edits them: lists as comma-separated text, timeouts as numbers, Linkup's params as JSON text. */
export function toWebForm(web: Rec): Rec {
	return {
		...web,
		WEB_SEARCH_DOMAIN_FILTER_LIST: joinList(web.WEB_SEARCH_DOMAIN_FILTER_LIST),
		YOUTUBE_LOADER_LANGUAGE: joinList(web.YOUTUBE_LOADER_LANGUAGE),
		FIRECRAWL_TIMEOUT: numberOrKeep(web.FIRECRAWL_TIMEOUT),
		PLAYWRIGHT_TIMEOUT: numberOrKeep(web.PLAYWRIGHT_TIMEOUT),
		LINKUP_SEARCH_PARAMS: typeof web.LINKUP_SEARCH_PARAMS === 'object' ? JSON.stringify(web.LINKUP_SEARCH_PARAMS ?? {}, null, 2) : (web.LINKUP_SEARCH_PARAMS ?? '')
	};
}

export type Prepared = { ok: true; payload: Rec } | { ok: false; error: string };

/** The body of `POST /retrieval/config/update` for this tab: only the `web` block, in the shapes the backend takes. */
export function prepareWebConfig(form: Rec): Prepared {
	let linkup: unknown = form.LINKUP_SEARCH_PARAMS;
	if (typeof linkup === 'string') {
		if (linkup.trim() === '') linkup = {};
		else {
			try {
				linkup = JSON.parse(linkup);
			} catch {
				return { ok: false, error: 'Invalid JSON format in Linkup Parameters' };
			}
			if (linkup === null || typeof linkup !== 'object' || Array.isArray(linkup)) return { ok: false, error: 'Invalid JSON format in Linkup Parameters' };
		}
	}
	return {
		ok: true,
		payload: {
			web: {
				...form,
				WEB_SEARCH_DOMAIN_FILTER_LIST: splitList(form.WEB_SEARCH_DOMAIN_FILTER_LIST),
				YOUTUBE_LOADER_LANGUAGE: splitList(form.YOUTUBE_LOADER_LANGUAGE),
				// These two fields are strings on the backend even though they are edited as numbers.
				FIRECRAWL_TIMEOUT: typeof form.FIRECRAWL_TIMEOUT === 'number' ? String(form.FIRECRAWL_TIMEOUT) : form.FIRECRAWL_TIMEOUT,
				PLAYWRIGHT_TIMEOUT: typeof form.PLAYWRIGHT_TIMEOUT === 'number' ? String(form.PLAYWRIGHT_TIMEOUT) : form.PLAYWRIGHT_TIMEOUT,
				LINKUP_SEARCH_PARAMS: linkup ?? {}
			}
		}
	};
}
