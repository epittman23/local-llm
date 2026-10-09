import { describe, expect, it } from 'vitest';
import {
	blankToolServerFields,
	buildToolServer,
	exportToolServer,
	importToolServer,
	registrationPayload,
	registrationProblem,
	specRequestUrl,
	toolServerFields,
	validateToolServer,
	verifyPayload,
	verifyProblem
} from './toolServerModel';

const fields = (patch = {}) => ({ ...blankToolServerFields(), url: 'https://tools.example/', ...patch });

describe('specRequestUrl', () => {
	it('joins a relative path onto the URL with one slash, and keeps a full URL as-is', () => {
		expect(specRequestUrl('https://t.example', 'openapi.json')).toBe('https://t.example/openapi.json');
		expect(specRequestUrl('https://t.example', '/openapi.json')).toBe('https://t.example/openapi.json');
		expect(specRequestUrl('https://t.example', 'https://other.example/spec.json')).toBe(
			'https://other.example/spec.json'
		);
	});
});

describe('toolServerFields', () => {
	it('is blank without a connection', () => {
		expect(toolServerFields(null)).toEqual(blankToolServerFields());
	});
	it('reads an existing connection, defaulting what is missing', () => {
		const f = toolServerFields({
			url: 'https://t',
			type: 'mcp',
			headers: { A: '1' },
			info: { id: 'x', oauth_scope: 's' },
			config: { enable: false, access_grants: [{ principal_type: 'user' } as any] }
		});
		expect(f).toMatchObject({
			type: 'mcp',
			url: 'https://t',
			path: 'openapi.json',
			authType: 'bearer',
			headers: '{\n  "A": "1"\n}',
			id: 'x',
			oauthScope: 's',
			oauthResourceParameter: 'auto',
			enable: false
		});
		expect(f.accessGrants).toHaveLength(1);
	});
});

describe('validateToolServer', () => {
	it('drops the trailing slash for OpenAPI but keeps it for MCP', () => {
		const a = validateToolServer(fields());
		const b = validateToolServer(fields({ type: 'mcp' }));
		expect('fields' in a && a.fields.url).toBe('https://tools.example');
		expect('fields' in b && b.fields.url).toBe('https://tools.example/');
	});
	it('refuses ":" or "|" in the ID', () => {
		expect(validateToolServer(fields({ id: 'a:b' }))).toEqual({ error: 'ID cannot contain ":" or "|" characters' });
		expect(validateToolServer(fields({ id: 'a|b' }))).toEqual({ error: 'ID cannot contain ":" or "|" characters' });
	});
	it('needs a registered client for MCP OAuth 2.1', () => {
		expect(validateToolServer(fields({ type: 'mcp', authType: 'oauth_2.1' }))).toEqual({
			error: 'Please register the OAuth client'
		});
		expect(
			'fields' in validateToolServer(fields({ type: 'mcp', authType: 'oauth_2.1', oauthClientInfo: { x: 1 } }))
		).toBe(true);
	});
	it('pretty-prints a JSON spec and refuses a bad one', () => {
		const ok = validateToolServer(fields({ specType: 'json', spec: '{"openapi":"3"}' }));
		expect('fields' in ok && ok.fields.spec).toBe('{\n  "openapi": "3"\n}');
		expect(validateToolServer(fields({ specType: 'json', spec: '{' }))).toEqual({
			error: 'Please enter a valid JSON spec'
		});
	});
	it('parses headers and refuses a non-object', () => {
		const ok = validateToolServer(fields({ headers: '{"X":"1"}' }));
		expect('headers' in ok && ok.headers).toEqual({ X: '1' });
		expect(validateToolServer(fields({ headers: '[]' }))).toEqual({ error: 'Headers must be a valid JSON object' });
	});
});

describe('buildToolServer', () => {
	it('puts enable, the filter list and access in config, and names in info', () => {
		const c = buildToolServer(fields({ id: 'srv', name: 'N', functionNameFilterList: 'a, !b' }), null);
		expect(c).toMatchObject({
			type: 'openapi',
			path: 'openapi.json',
			auth_type: 'bearer',
			headers: undefined,
			config: { enable: true, function_name_filter_list: 'a, !b', access_grants: [] },
			info: { id: 'srv', name: 'N', description: '' }
		});
		expect(c.info).not.toHaveProperty('oauth_resource_parameter');
	});
	it('adds the OAuth keys only where they apply', () => {
		const c = buildToolServer(
			fields({
				type: 'mcp',
				authType: 'oauth_2.1_static',
				oauthClientInfo: { c: 1 },
				oauthClientId: 'cid',
				oauthClientSecret: 'sec',
				oauthServerUrl: 'https://auth',
				oauthScope: ''
			}),
			null
		);
		expect(c.info).toEqual({
			id: '',
			name: '',
			description: '',
			oauth_resource_parameter: 'auto',
			oauth_client_info: { c: 1 },
			oauth_client_id: 'cid',
			oauth_client_secret: 'sec',
			oauth_server_url: 'https://auth'
		});
	});
});

describe('verify and registration', () => {
	it('needs a URL, and for OpenAPI a spec or path', () => {
		expect(verifyProblem(fields({ url: '' }))).toBe('Please enter a valid URL');
		expect(verifyProblem(fields({ path: '' }))).toBe('Please enter a valid path');
		expect(verifyProblem(fields({ specType: 'json' }))).toBe('Please enter a valid JSON spec');
		expect(verifyProblem(fields({ type: 'mcp', path: '' }))).toBeNull();
	});
	it('the verify body carries OAuth discovery hints only for OAuth 2.1', () => {
		expect(verifyPayload(fields(), null).info).toEqual({ id: '', name: '', description: '' });
		expect(
			verifyPayload(fields({ authType: 'oauth_2.1', oauthServerUrl: 'https://a', oauthScope: 'x' }), null).info
		).toEqual({
			id: '',
			name: '',
			description: '',
			oauth_server_url: 'https://a',
			oauth_scope: 'x',
			oauth_resource_parameter: 'auto'
		});
	});
	it('registration needs the URL, the ID, and for static both credentials', () => {
		expect(registrationProblem(fields({ id: '' }))).toBe('Please enter a valid ID');
		expect(registrationProblem(fields({ id: 'x', authType: 'oauth_2.1_static', oauthClientId: 'a' }))).toBe(
			'Please enter Client ID and Client Secret'
		);
		expect(
			registrationPayload(
				fields({ id: 'x', authType: 'oauth_2.1_static', oauthClientSecret: 's', oauthServerUrl: 'https://a' })
			)
		).toEqual({ url: 'https://tools.example/', client_id: 'x', client_secret: 's', oauth_server_url: 'https://a' });
		expect(registrationPayload(fields({ id: 'x', authType: 'oauth_2.1', oauthScope: 'read' }))).toEqual({
			url: 'https://tools.example/',
			client_id: 'x',
			oauth_scope: 'read'
		});
	});
});

describe('export / import', () => {
	it('exports a one-element array without the key or secrets', () => {
		const out = exportToolServer(
			fields({ key: 'sk-secret', authType: 'oauth_2.1_static', oauthClientSecret: 'shh', id: 'a' }),
			{ X: '1' }
		);
		expect(out).toHaveLength(1);
		expect(JSON.stringify(out)).not.toContain('sk-secret');
		expect(JSON.stringify(out)).not.toContain('shh');
		expect(out[0]).toMatchObject({ url: 'https://tools.example/', headers: { X: '1' }, info: { id: 'a' } });
	});
	it('imports the first element over the form, ignoring access grants', () => {
		const start = fields({ accessGrants: [{ principal_type: 'user', principal_id: 'me' } as any], name: 'keep?' });
		const f = importToolServer(
			JSON.stringify([
				{
					type: 'mcp',
					url: 'https://m',
					headers: { A: 1 },
					info: { id: 'm1' },
					config: { enable: false, access_grants: [{ principal_id: '*' }] }
				}
			]),
			start
		);
		expect(f).toMatchObject({
			type: 'mcp',
			url: 'https://m',
			headers: '{\n  "A": 1\n}',
			id: 'm1',
			name: '',
			enable: false
		});
		expect(f.accessGrants).toEqual(start.accessGrants);
	});
	it('refuses an empty array, a non-object, and bad JSON', () => {
		expect(() => importToolServer('[]', fields())).toThrow();
		expect(() => importToolServer('"x"', fields())).toThrow();
		expect(() => importToolServer('{', fields())).toThrow();
	});
});
