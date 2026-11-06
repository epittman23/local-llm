// Verbatim from d863707:apps/openwebui/src/lib/utils/index.ts (the 2334-line kitchen-sink
// module the SvelteKit app shares between every surface). Only the four helpers
// `src/lib/apis/**` actually imports are ported here; the rest of that file belongs
// to whichever later phase ports the surface that uses it (chat, admin, workspace),
// not to the API layer's own foundation.

const MONTH_NAMES = [
	'January',
	'February',
	'March',
	'April',
	'May',
	'June',
	'July',
	'August',
	'September',
	'October',
	'November',
	'December'
];

export const splitStream = (splitOn: string) => {
	let buffer = '';
	return new TransformStream({
		transform(chunk, controller) {
			buffer += chunk;
			const parts = buffer.split(splitOn);
			parts.slice(0, -1).forEach((part) => controller.enqueue(part));
			buffer = parts[parts.length - 1];
		},
		flush(controller) {
			if (buffer) controller.enqueue(buffer);
		}
	});
};

export const getUserPosition = async (raw = false) => {
	// Get the user's location using the Geolocation API
	const position = await new Promise((resolve, reject) => {
		navigator.geolocation.getCurrentPosition(resolve, reject);
	}).catch((error) => {
		console.error('Error getting user location:', error);
		throw error;
	});

	if (!position) {
		return 'Location not available';
	}

	// Extract the latitude and longitude from the position
	const { latitude, longitude } = (position as GeolocationPosition).coords;

	if (raw) {
		return { latitude, longitude };
	} else {
		return `${latitude.toFixed(3)}, ${longitude.toFixed(3)} (lat, long)`;
	}
};

/**
 * The sidebar-style bucket for a time in *seconds*: Today, Yesterday, Previous
 * 7 / 30 days, the month name this year, else the year. Days are counted in
 * local calendar days, so the 30th is "Yesterday" on the 1st (the original
 * compared day-of-month numbers and missed that across a month boundary).
 */
export const getTimeRange = (timestamp: number, now = new Date()) => {
	const date = new Date(timestamp * 1000);
	const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
	const calendarDays = Math.round((midnight(now) - midnight(date)) / 86_400_000);
	const diffDays = (now.getTime() - date.getTime()) / 86_400_000;
	if (calendarDays === 0) return 'Today';
	if (calendarDays === 1) return 'Yesterday';
	if (diffDays <= 7) return 'Previous 7 days';
	if (diffDays <= 30) return 'Previous 30 days';
	if (now.getFullYear() === date.getFullYear()) return MONTH_NAMES[date.getMonth()];
	return date.getFullYear().toString();
};

function resolveSchema(schemaRef: any, components: any, resolvedSchemas = new Set<string>()): any {
	if (!schemaRef) return {};

	if (schemaRef['$ref']) {
		const refPath = schemaRef['$ref'];
		const schemaName = refPath.split('/').pop();

		if (resolvedSchemas.has(schemaName)) {
			// Avoid infinite recursion on circular references
			return {};
		}
		// The refs on this path only, so a sibling may use the same one (#613).
		const referencedSchema = components.schemas[schemaName];
		return resolveSchema(referencedSchema, components, new Set([...resolvedSchemas, schemaName]));
	}

	if (schemaRef.type) {
		const schemaObj: any = { type: schemaRef.type };

		if (schemaRef.description) {
			schemaObj.description = schemaRef.description;
		}

		switch (schemaRef.type) {
			case 'object':
				schemaObj.properties = {};
				schemaObj.required = schemaRef.required || [];
				for (const [propName, propSchema] of Object.entries(schemaRef.properties || {})) {
					schemaObj.properties[propName] = resolveSchema(propSchema, components, resolvedSchemas);
				}
				break;

			case 'array':
				schemaObj.items = resolveSchema(schemaRef.items, components, resolvedSchemas);
				break;

			default:
				// OpenAPI 3.1's type list, as `['array', 'null']`, keeps its items too.
				if (Array.isArray(schemaRef.type) && schemaRef.type.includes('array') && schemaRef.items)
					schemaObj.items = resolveSchema(schemaRef.items, components, resolvedSchemas);
				// for primitive types (string, integer, etc.), just use as is
				break;
		}

		// Resolve composition keywords (oneOf, anyOf, allOf) which may contain $ref
		for (const keyword of ['oneOf', 'anyOf', 'allOf']) {
			if (Array.isArray(schemaRef[keyword])) {
				schemaObj[keyword] = schemaRef[keyword].map((inner: any) => resolveSchema(inner, components, resolvedSchemas));
			}
		}

		return schemaObj;
	}

	// Handle schemas that only have composition keywords without an explicit type
	const compositionObj: Record<string, any> = {};
	let hasComposition = false;
	for (const keyword of ['oneOf', 'anyOf', 'allOf']) {
		if (Array.isArray(schemaRef[keyword])) {
			compositionObj[keyword] = schemaRef[keyword].map((inner: any) =>
				resolveSchema(inner, components, resolvedSchemas)
			);
			hasComposition = true;
		}
	}
	if (hasComposition) {
		if (schemaRef.description) compositionObj.description = schemaRef.description;
		return compositionObj;
	}

	// fallback for schemas without explicit type
	return {};
}

/**
 * Header parameters a direct tool server is never given from the model's
 * arguments, nor offers it, lowercased: the backend's list (#190) with its
 * default forwarding header names, and the headers a browser's fetch will not
 * set at all (#613).
 */
const RESERVED_HEADER_PARAMETERS = new Set(
	[
		'Accept',
		'Content-Type',
		'Authorization',
		'Host',
		'Content-Length',
		'Transfer-Encoding',
		'Connection',
		'Cookie',
		'X-User-Id',
		'X-Session-Id',
		'X-Terminal-Context-Id',
		'X-LLLM-User-Name',
		'X-LLLM-User-Id',
		'X-LLLM-User-Email',
		'X-LLLM-User-Role',
		'X-LLLM-User-Jwt',
		'X-LLLM-Chat-Id',
		'X-LLLM-Message-Id',
		// Forbidden request headers (the Fetch standard).
		'Accept-Charset',
		'Accept-Encoding',
		'Access-Control-Request-Headers',
		'Access-Control-Request-Method',
		'Access-Control-Request-Private-Network',
		'Cookie2',
		'Date',
		'DNT',
		'Expect',
		'Keep-Alive',
		'Origin',
		'Referer',
		'Set-Cookie',
		'TE',
		'Trailer',
		'Upgrade',
		'Via'
	].map((name) => name.toLowerCase())
);

/**
 * Whether a direct tool server offers an operation parameter to the model
 * and sends it (#613). A reserved header is neither; nor is a cookie
 * parameter, since a browser's fetch cannot set the Cookie header.
 */
export function isSendableParameter(param: { name?: string; in?: string }): boolean {
	if (param?.in === 'cookie') return false;
	if (param?.in !== 'header') return true;
	const name = String(param.name ?? '').toLowerCase();
	return !(RESERVED_HEADER_PARAMETERS.has(name) || name.startsWith('proxy-') || name.startsWith('sec-'));
}

/**
 * A header value as text, in OpenAPI's default "simple" style, as the backend
 * writes it: an array joins its values with commas, skipping nulls; an object
 * joins its keys and values the same way (`{a: 1, b: 2}` is `a,1,b,2`).
 */
export function parameterText(value: unknown): string {
	if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
		value = Object.entries(value).flatMap(([key, item]) => (item === null || item === undefined ? [] : [key, item]));
	}
	if (Array.isArray(value))
		return value
			.filter((item) => item !== null && item !== undefined)
			.map(parameterText)
			.join(',');
	return String(value);
}

/** A JSON schema as the tool-server helpers read it. */
type JsonSchema = {
	type?: unknown;
	properties?: Record<string, unknown>;
	required?: string[];
	items?: unknown;
	anyOf?: unknown;
	oneOf?: unknown;
	[key: string]: unknown;
};

/** An operation's JSON request body schema, its $refs resolved; `{}` if it has none. */
export function jsonBodySchema(
	operation: { requestBody?: { content?: Record<string, { schema?: unknown }> } } | undefined,
	components: unknown
): JsonSchema {
	return resolveSchema(operation?.requestBody?.content?.['application/json']?.schema, components ?? {});
}

/**
 * The array a request body schema describes, as the tool offers it; null if
 * it is not one (#191). An optional array (an anyOf or oneOf of one array and
 * null, or a type list such as `['array', 'null']`) counts too. A missing
 * `items` is `{}`, since OpenAI refuses an array schema without one.
 */
export function arrayBodySchema(schema: JsonSchema | null | undefined): JsonSchema | null {
	if (!schema || schema.properties) return null;
	const kind = schema.type;
	let array: JsonSchema | null = null;
	if (
		kind === 'array' ||
		(Array.isArray(kind) && kind.includes('array') && kind.every((k) => k === 'array' || k === 'null'))
	) {
		array = { ...schema, type: 'array' };
	} else {
		for (const keyword of ['anyOf', 'oneOf']) {
			const branches = schema[keyword];
			if (!Array.isArray(branches)) continue;
			const rest = (branches as (JsonSchema | null)[]).filter((branch) => branch?.type !== 'null');
			if (rest.length === 1 && rest[0]?.type === 'array') {
				const { anyOf: _anyOf, oneOf: _oneOf, ...outer } = schema;
				array = { ...outer, ...rest[0] };
			}
		}
		if (array === null) return null;
	}
	return 'items' in array ? array : { ...array, items: {} };
}

/** The tool argument an array request body is offered as: `body`, or `request_body` (and so on) if a parameter has that name. */
export function arrayBodyProperty(parameters: { name?: string }[]): string {
	const taken = new Set(parameters.map((param) => param?.name));
	let name = 'body';
	while (taken.has(name)) name = `request_${name}`;
	return name;
}

// Valid HTTP methods per OpenAPI 3.x – used to skip extension keys (x-*)
// and non-operation path-item fields (summary, description, servers, parameters).
const OPENAPI_HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

export const convertOpenApiToToolPayload = (openApiSpec: any) => {
	const toolPayload: any[] = [];

	// Guard against invalid or non-OpenAPI specs (e.g., MCP-style configs)
	if (!openApiSpec || !openApiSpec.paths) {
		return toolPayload;
	}

	for (const [, methods] of Object.entries(openApiSpec.paths)) {
		if (!methods || typeof methods !== 'object') continue;

		// Path-level parameters apply to all operations under this path
		// unless overridden at the operation level (matched by name + in).
		const pathLevelParams: any[] = Array.isArray((methods as any).parameters) ? (methods as any).parameters : [];

		for (const [method, operation] of Object.entries(methods)) {
			if (!OPENAPI_HTTP_METHODS.has(method)) continue;
			if (!operation || typeof operation !== 'object') continue;
			if ((operation as any)?.operationId) {
				const tool: any = {
					name: (operation as any).operationId,
					description: (operation as any).description || (operation as any).summary || 'No description available.',
					parameters: {
						type: 'object',
						properties: {} as Record<string, any>,
						required: [] as string[]
					}
				};

				// Merge path-level and operation-level parameters.
				// Operation-level params override path-level params with the
				// same (name, in) pair per the OpenAPI spec.
				const opParams: any[] = Array.isArray((operation as any).parameters) ? (operation as any).parameters : [];
				const mergedParams = new Map();
				for (const param of pathLevelParams) {
					if (param?.name) mergedParams.set(`${param.name}:${param.in ?? ''}`, param);
				}
				for (const param of opParams) {
					if (param?.name) mergedParams.set(`${param.name}:${param.in ?? ''}`, param);
				}

				// The parameters it can send: path, query and header (#613).
				for (const param of mergedParams.values()) {
					const paramName = param?.name;
					if (!paramName || !isSendableParameter(param)) continue;
					const paramSchema = param?.schema ?? {};
					let description = paramSchema.description || param.description || '';
					if (paramSchema.enum && Array.isArray(paramSchema.enum)) {
						description += `. Possible values: ${paramSchema.enum.join(', ')}`;
					}
					// As the backend offers it: a string unless typed, and an array with its items.
					tool.parameters.properties[paramName] = {
						type: paramSchema.type || 'string',
						description: description,
						...(paramSchema.type === 'array' && 'items' in paramSchema && { items: paramSchema.items })
					};

					if (param.required) {
						tool.parameters.required.push(paramName);
					}
				}

				// The JSON request body's fields join the parameters; an array body is
				// one property of its own beside them (#191, #613).
				const resolvedRequestSchema = jsonBodySchema(operation, openApiSpec.components);
				const arrayBody = arrayBodySchema(resolvedRequestSchema);
				if (resolvedRequestSchema.properties) {
					tool.parameters.properties = {
						...tool.parameters.properties,
						...resolvedRequestSchema.properties
					};

					if (resolvedRequestSchema.required) {
						tool.parameters.required = [...new Set([...tool.parameters.required, ...resolvedRequestSchema.required])];
					}
				} else if (arrayBody) {
					const bodyProperty = arrayBodyProperty([...mergedParams.values()]);
					tool.parameters.properties[bodyProperty] = arrayBody;
					if ((operation as any).requestBody?.required) tool.parameters.required.push(bodyProperty);
				}

				toolPayload.push(tool);
			}
		}
	}

	return toolPayload;
};
