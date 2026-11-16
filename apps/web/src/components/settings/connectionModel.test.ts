import { describe, expect, it } from 'vitest';
import {
	blankFields,
	buildConnection,
	fieldsFromConnection,
	isAzure,
	modelListResult,
	parseHeaders,
	parsePassthroughParams,
	urlProblem,
	validateConnection,
	verifyConfig
} from './connectionModel';

const openai = { ollama: false, direct: false };

describe('isAzure', () => {
	it('is explicit for provider=azure and guessed from Azure-looking URLs', () => {
		expect(isAzure('azure', 'https://x.example', false)).toBe(true);
		expect(isAzure('', 'https://my.openai.azure.com/', false)).toBe(true);
		expect(isAzure('', 'https://my.cognitive.microsoft.com', false)).toBe(true);
	});
	it('is not guessed for direct connections, another provider, or the /openai/v1 path', () => {
		expect(isAzure('', 'https://my.openai.azure.com', true)).toBe(false);
		expect(isAzure('litellm', 'https://my.openai.azure.com', false)).toBe(false);
		expect(isAzure('', 'https://my.openai.azure.com/openai/v1', false)).toBe(false);
		expect(isAzure('', 'https://openrouter.ai/api/v1', false)).toBe(false);
	});
	it('looks at the host, not anywhere in the URL', () => {
		expect(isAzure('', 'https://x.services.ai.azure.com', false)).toBe(true);
		expect(isAzure('', 'https://proxy.example/?to=my.openai.azure.com', false)).toBe(false);
		expect(isAzure('', 'https://proxy.example/cognitive.microsoft.com', false)).toBe(false);
		expect(isAzure('', 'https://notcognitive.microsoft.com', false)).toBe(false);
		expect(isAzure('', 'my.openai.azure.com', false)).toBe(true);
		expect(isAzure('', 'my.openai.azure', false)).toBe(false);
	});
});

describe('parsePassthroughParams / parseHeaders', () => {
	it('splits, trims and drops blanks', () => {
		expect(parsePassthroughParams(' a, b ,, c ')).toEqual(['a', 'b', 'c']);
		expect(parsePassthroughParams('')).toEqual([]);
	});
	it('accepts empty headers, pretty-prints an object, and refuses anything else', () => {
		expect(parseHeaders('  ')).toEqual({ value: null, text: '  ' });
		expect(parseHeaders('{"X-A":"1"}')).toEqual({ value: { 'X-A': '1' }, text: '{\n  "X-A": "1"\n}' });
		expect(() => parseHeaders('[1]')).toThrow(/valid JSON object/);
		expect(() => parseHeaders('null')).toThrow(/valid JSON object/);
		expect(() => parseHeaders('{oops')).toThrow();
	});
});

describe('fieldsFromConnection', () => {
	it('starts blank for a new connection, local for Ollama', () => {
		expect(fieldsFromConnection(null, { ollama: false })).toEqual(blankFields());
		expect(fieldsFromConnection(null, { ollama: true }).connectionType).toBe('local');
	});
	it('reads an existing connection, including legacy shapes', () => {
		const f = fieldsFromConnection(
			{
				url: 'https://api',
				key: 'k',
				config: {
					enable: false,
					tags: ['a', { name: 'b' }],
					prefix_id: 'p',
					model_ids: ['m', 'm', 'n'],
					passthrough_params: ['x', 'y'],
					azure: true,
					api_version: 'v1',
					headers: { H: '1' }
				}
			},
			{ ollama: false }
		);
		expect(f).toMatchObject({
			url: 'https://api',
			key: 'k',
			enable: false,
			prefixId: 'p',
			modelIds: ['m', 'n'],
			passthroughParams: 'x, y',
			provider: 'azure',
			apiVersion: 'v1',
			authType: 'bearer'
		});
		expect(f.tags).toEqual([{ name: 'a' }, { name: 'b' }]);
		expect(f.headers).toBe('{\n  "H": "1"\n}');
	});
});

describe('validateConnection', () => {
	it('needs an http or https URL, which Ollama may leave empty', () => {
		expect(validateConnection(blankFields(), openai)).toEqual({ field: 'url', message: 'Enter the server’s URL.' });
		expect(validateConnection({ ...blankFields(), url: 'localhost:8090' }, openai)?.message).toBe(
			'Enter a URL that starts with http:// or https://.'
		);
		expect(validateConnection(blankFields(), { ollama: true, direct: false })).toBeNull();
		expect(validateConnection({ ...blankFields(), url: 'nope' }, { ollama: true, direct: false })?.field).toBe('url');
	});
	it('holds Azure to API version, a key (unless Entra) and deployment names, opening Advanced where relevant', () => {
		const az = { ...blankFields(), provider: 'azure', url: 'https://x.openai.azure.com' };
		expect(validateConnection(az, openai)).toEqual({
			field: 'apiVersion',
			message: 'Enter the Azure API version.',
			openAdvanced: true
		});
		expect(validateConnection({ ...az, apiVersion: '1' }, openai)).toEqual({
			field: 'key',
			message: 'Enter the API key. Azure OpenAI needs one.'
		});
		expect(validateConnection({ ...az, apiVersion: '1', key: 'k' }, openai)).toEqual({
			field: 'modelIds',
			message: 'Add a deployment name. Azure OpenAI needs at least one.',
			openAdvanced: true
		});
		expect(
			validateConnection({ ...az, apiVersion: '1', authType: 'microsoft_entra_id', modelIds: ['d'] }, openai)
		).toBeNull();
	});
});

describe('buildConnection', () => {
	it('drops the trailing slash and shapes the config', () => {
		const c = buildConnection(
			{
				...blankFields(),
				url: 'https://openrouter.ai/api/v1/',
				key: 'sk',
				passthroughParams: 'a, b',
				modelIds: ['m'],
				apiType: 'responses',
				provider: 'litellm'
			},
			openai,
			null
		);
		expect(c.url).toBe('https://openrouter.ai/api/v1');
		expect(c.config).toMatchObject({
			enable: true,
			model_ids: ['m'],
			connection_type: 'external',
			auth_type: 'bearer',
			passthrough_params: ['a', 'b'],
			provider: 'litellm',
			api_type: 'responses'
		});
		expect(c.config).not.toHaveProperty('azure');
		expect(c.config.headers).toBeUndefined();
	});
	it('marks Azure and carries the API version', () => {
		const c = buildConnection(
			{ ...blankFields(), url: 'https://x.openai.azure.com', apiVersion: '2024-02-01' },
			openai,
			{ H: 1 }
		);
		expect(c.config).toMatchObject({ azure: true, api_version: '2024-02-01', headers: { H: 1 } });
	});
	it('never marks an Ollama connection as azure', () => {
		expect(
			buildConnection(
				{ ...blankFields(), url: 'https://x.openai.azure.com', provider: 'azure', apiVersion: '1' },
				{ ollama: true, direct: false },
				null
			).config
		).not.toHaveProperty('azure');
	});
});

describe('verifyConfig', () => {
	it('sends the auth and provider bits, and headers only when set', () => {
		expect(verifyConfig({ ...blankFields(), provider: 'llama.cpp' }, { direct: false }, null)).toEqual({
			auth_type: 'bearer',
			provider: 'llama.cpp',
			api_version: '',
			passthrough_params: []
		});
	});
});

describe('modelListResult', () => {
	it('counts the models in an OpenAI-style answer or a bare list', () => {
		expect(modelListResult({ data: [{ id: 'a' }, { id: 'b' }] })).toEqual({ ok: true, text: 'Reachable: 2 models' });
		expect(modelListResult([{ id: 'a' }])).toEqual({ ok: true, text: 'Reachable: 1 model' });
	});

	it('says when the server answered with something that is not a model list', () => {
		expect(modelListResult('<html>')).toEqual({
			ok: false,
			text: "Reached the server, but it didn't return a model list."
		});
		expect(modelListResult(null).ok).toBe(false);
	});
});

describe('urlProblem', () => {
	it('accepts http and https URLs', () => {
		expect(urlProblem('http://127.0.0.1:8090/v1')).toBeNull();
		expect(urlProblem(' https://openrouter.ai/api/v1 ')).toBeNull();
	});

	it('asks for a URL, and for http or https', () => {
		expect(urlProblem('  ')).toBe('Enter the server’s URL.');
		expect(urlProblem('not a url')).toBe('Enter a URL that starts with http:// or https://.');
		expect(urlProblem('ftp://host')).toBe('Enter a URL that starts with http:// or https://.');
	});
});
