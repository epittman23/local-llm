import { afterEach, describe, expect, it, vi } from 'vitest';
import { convertOpenApiToToolPayload } from '@/lib/utils/api-helpers';
import { executeToolServer } from './index';

// The browser's copy of the OpenAPI tool-server code, for direct tool servers,
// follows the backend's header (#190) and array-body (#191) rules (#613); these
// mirror apps/server/tests/test_tool_server_header_params.py and
// test_tool_server_array_body.py. A browser's fetch cannot set a Cookie header,
// so a cookie parameter is not offered to the model at all.

type Sent = { url: string; method: string; headers: Record<string, string>; body: unknown };

afterEach(() => vi.restoreAllMocks());

async function call(openapi: object, name: string, params: Record<string, unknown>, sessionId?: string) {
	const sent: Sent[] = [];
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
		sent.push({
			url: String(url),
			method: String(init?.method),
			headers: { ...(init?.headers as Record<string, string>) },
			body: init?.body === undefined ? 'no body' : JSON.parse(String(init.body))
		});
		return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
	});
	const [result] = await executeToolServer(
		't',
		'https://items.test',
		name,
		params,
		{ openapi, info: {}, specs: [] },
		sessionId
	);
	expect(result).toEqual({ ok: true });
	expect(sent).toHaveLength(1);
	return sent[0];
}

const server = (parameters: object[]) => ({ paths: { '/items': { get: { operationId: 'list_items', parameters } } } });
const VERSION = { name: 'X-Api-Version', in: 'header', required: true, schema: { type: 'string' } };
const SESSION = { name: 'session', in: 'cookie', schema: { type: 'string' } };
const QUERY = { name: 'q', in: 'query', schema: { type: 'string' } };
const OWN = { 'Content-Type': 'application/json', authorization: 'Bearer t' };

describe('direct tool servers: header parameters (#190, #613)', () => {
	it('sends a header parameter as a header', async () => {
		const request = await call(server([VERSION, QUERY]), 'list_items', { 'X-Api-Version': '2', q: 'x' });

		expect(request.headers).toEqual({ ...OWN, 'X-Api-Version': '2' });
		expect(request.url).toBe('https://items.test/items?q=x');
	});

	it('writes header values as text, in the simple style', async () => {
		const parameters = ['X-Count', 'X-Dry-Run', 'X-Tags', 'X-Filter'].map((name) => ({ name, in: 'header' }));
		const request = await call(server(parameters), 'list_items', {
			'X-Count': 3,
			'X-Dry-Run': true,
			'X-Tags': ['a', null, 'b'],
			'X-Filter': { a: 1, b: null, c: 'x' }
		});

		expect(request.headers).toEqual({
			...OWN,
			'X-Count': '3',
			'X-Dry-Run': 'true',
			'X-Tags': 'a,b',
			'X-Filter': 'a,1,c,x'
		});
	});

	it('does not send a missing, null or empty optional header', async () => {
		const parameters = [
			{ name: 'X-Trace', in: 'header' },
			{ name: 'X-Other', in: 'header' }
		];
		const request = await call(server(parameters), 'list_items', { 'X-Trace': '', 'X-Other': null });

		expect(request.headers).toEqual(OWN);
	});

	it("keeps the page's own session header when a parameter has its name", async () => {
		const request = await call(
			server([
				{ name: 'x-session-id', in: 'header' },
				{ name: 'X-Mine', in: 'header' }
			]),
			'list_items',
			{
				'x-session-id': 'from-model',
				'X-Mine': 'm'
			},
			's1'
		);

		expect(request.headers).toEqual({ 'X-Mine': 'm', ...OWN, 'X-Session-Id': 's1' });
	});

	it.each([
		'Authorization',
		'accept',
		'Content-Type',
		'Host',
		'Cookie',
		'X-User-Id',
		'x-session-id',
		'X-Terminal-Context-Id',
		'x-lllm-user-id',
		'X-LLLM-Chat-Id',
		// Headers a browser's fetch will not set.
		'Origin',
		'Referer',
		'Sec-Fetch-Mode',
		'Proxy-Authorization'
	])('neither offers nor sends the reserved header %s', async (name) => {
		const parameters = [{ name, in: 'header', schema: { type: 'string' } }, QUERY];
		const [tool] = convertOpenApiToToolPayload(server(parameters));
		const request = await call(server(parameters), 'list_items', { [name]: 'from-model' });

		expect(Object.keys(tool.parameters.properties)).toEqual(['q']);
		expect(request.headers).toEqual(OWN);
	});

	it('offers header parameters but not cookie ones, which a browser cannot send', async () => {
		const [tool] = convertOpenApiToToolPayload(server([VERSION, SESSION, QUERY]));
		const request = await call(server([VERSION, SESSION, QUERY]), 'list_items', {
			'X-Api-Version': '2',
			session: 'abc'
		});

		expect(Object.keys(tool.parameters.properties)).toEqual(['X-Api-Version', 'q']);
		expect(tool.parameters.required).toEqual(['X-Api-Version']);
		expect(request.headers).toEqual({ ...OWN, 'X-Api-Version': '2' });
	});

	it('still offers and sends a query parameter named like a reserved header', async () => {
		const parameters = [{ name: 'host', in: 'query', schema: { type: 'string' } }];
		const [tool] = convertOpenApiToToolPayload(server(parameters));
		const request = await call(server(parameters), 'list_items', { host: 'a.example' });

		expect(Object.keys(tool.parameters.properties)).toEqual(['host']);
		expect(request.url).toBe('https://items.test/items?host=a.example');
	});
});

const TAG_ARRAY = { type: 'array', items: { type: 'string' } };

function spec(
	schema?: object,
	{ parameters = [] as object[], required = undefined as boolean | undefined, method = 'post' } = {}
) {
	const body: Record<string, unknown> = {
		content: { 'application/json': { schema: schema ?? { $ref: '#/components/schemas/Tags' } } }
	};
	if (required !== undefined) body.required = required;
	return {
		paths: {
			'/lists/{list_id}/tags': {
				[method]: {
					operationId: 'bulk_add',
					parameters: [{ name: 'list_id', in: 'path', required: true }, ...parameters],
					requestBody: body
				}
			}
		},
		components: { schemas: { Tags: TAG_ARRAY } }
	};
}
const tool = (s: object) => convertOpenApiToToolPayload(s)[0];
const OPTIONAL_TAGS = [
	{ anyOf: [TAG_ARRAY, { type: 'null' }], title: 'Tags' },
	{ oneOf: [{ type: 'null' }, TAG_ARRAY] },
	{ type: ['array', 'null'], items: { type: 'string' } }
];

describe('direct tool servers: an array request body (#191, #613)', () => {
	it('takes an object with the array beside the parameters', () => {
		const parameters = tool(spec(undefined, { required: true })).parameters;

		expect(parameters.type).toBe('object');
		expect(parameters.properties.body).toEqual(TAG_ARRAY);
		expect(Object.keys(parameters.properties)).toContain('list_id');
		expect([...parameters.required].sort()).toEqual(['body', 'list_id']);
	});

	it('does not require an optional array body', () => {
		expect(tool(spec()).parameters.required).toEqual(['list_id']);
	});

	it.each(['post', 'put', 'patch', 'delete'])('sends the array itself as the %s body', async (method) => {
		const request = await call(spec(undefined, { method }), 'bulk_add', { list_id: 'l1', body: ['a', 'b'] });

		expect(request.url).toBe('https://items.test/lists/l1/tags');
		expect(request.method).toBe(method.toUpperCase());
		expect(request.body).toEqual(['a', 'b']);
	});

	it('sends no body when the array is left out or null', async () => {
		expect((await call(spec(), 'bulk_add', { list_id: 'l1' })).body).toBe('no body');
		expect((await call(spec(OPTIONAL_TAGS[0]), 'bulk_add', { list_id: 'l1', body: null })).body).toBe('no body');
	});

	it('names the array request_body beside a parameter named body, and still sends it as the body', async () => {
		const s = spec(TAG_ARRAY, { parameters: [{ name: 'body', in: 'query' }] });
		const properties = tool(s).parameters.properties;
		const request = await call(s, 'bulk_add', { list_id: 'l1', body: 'q', request_body: ['a'] });

		expect(properties.body).toEqual({ type: 'string', description: '' });
		expect(properties.request_body).toEqual(TAG_ARRAY);
		expect(request.url).toBe('https://items.test/lists/l1/tags?body=q');
		expect(request.body).toEqual(['a']);
	});

	it('offers an array without items with any items', () => {
		expect(tool(spec({ type: 'array' })).parameters.properties.body).toEqual({ type: 'array', items: {} });
	});

	it.each(OPTIONAL_TAGS)('offers and sends an optional array body as the array (%j)', async (schema) => {
		const body = tool(spec(schema)).parameters.properties.body;
		const request = await call(spec(schema), 'bulk_add', { list_id: 'l1', body: ['a'] });

		expect(body.type).toBe('array');
		expect(body.items).toEqual({ type: 'string' });
		expect(request.body).toEqual(['a']);
	});

	it('does not read a union of an array and an object as an array', () => {
		expect(tool(spec({ anyOf: [TAG_ARRAY, { type: 'object' }] })).parameters.properties.body).toBeUndefined();
	});

	it('leaves an object body as it was', async () => {
		const s = spec({ type: 'object', properties: { tags: TAG_ARRAY }, required: ['tags'] });
		const parameters = tool(s).parameters;

		expect(Object.keys(parameters.properties).sort()).toEqual(['list_id', 'tags']);
		expect((await call(s, 'bulk_add', { list_id: 'l1', tags: ['a'] })).body).toEqual({ tags: ['a'] });
	});
});

describe('direct tool servers: the rest of the call, as the backend makes it (#613)', () => {
	it('keeps the parameters out of an object body, unless the body has a field of that name', async () => {
		const s = {
			paths: {
				'/users/{id}': {
					put: {
						operationId: 'update_user',
						parameters: [
							{ name: 'id', in: 'path', required: true },
							{ name: 'X-Api-Key', in: 'header' },
							{ name: 'session', in: 'cookie' }
						],
						requestBody: {
							content: {
								'application/json': {
									schema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } }
								}
							}
						}
					}
				}
			}
		};
		const request = await call(s, 'update_user', { id: 'u1', 'X-Api-Key': 'k', session: 's', name: 'n' });

		expect(request.url).toBe('https://items.test/users/u1');
		expect(request.headers['X-Api-Key']).toBe('k');
		expect(request.body).toEqual({ id: 'u1', name: 'n' });
	});

	it('leaves the parameters out of a body whose schema names no fields', async () => {
		const s = spec({ anyOf: [{ type: 'object' }, { type: 'string' }] });
		const request = await call(s, 'bulk_add', { list_id: 'l1', note: 'n' });

		expect(request.body).toEqual({ note: 'n' });
	});

	it('offers an untyped parameter as a string, and an array one with its items', () => {
		const [t] = convertOpenApiToToolPayload(
			server([
				{ name: 'q', in: 'query' },
				{ name: 'tags', in: 'query', schema: { type: 'array', items: { type: 'string' } } }
			])
		);

		expect(t.parameters.properties).toEqual({
			q: { type: 'string', description: '' },
			tags: { type: 'array', description: '', items: { type: 'string' } }
		});
	});

	it('resolves a schema that refers to itself, and a ref used twice side by side', () => {
		const node = {
			type: 'object',
			properties: {
				children: { type: ['array', 'null'], items: { $ref: '#/components/schemas/Node' } },
				parent: { $ref: '#/components/schemas/Leaf' },
				sibling: { $ref: '#/components/schemas/Leaf' }
			}
		};
		const s = {
			paths: {
				'/nodes': {
					post: {
						operationId: 'add_node',
						requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } } }
					}
				}
			},
			components: { schemas: { Node: node, Leaf: { type: 'string' } } }
		};
		const [t] = convertOpenApiToToolPayload(s);

		expect(t.parameters.properties.children).toEqual({ type: ['array', 'null'], items: {} });
		expect(t.parameters.properties.parent).toEqual({ type: 'string' });
		expect(t.parameters.properties.sibling).toEqual({ type: 'string' });
	});
});
