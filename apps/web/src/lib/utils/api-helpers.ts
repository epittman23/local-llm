// Verbatim from apps/openwebui/src/lib/utils/index.ts (the 2334-line kitchen-sink
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

export const getTimeRange = (timestamp: number) => {
	const now = new Date();
	const date = new Date(timestamp * 1000); // Convert Unix timestamp to milliseconds

	// Calculate the difference in milliseconds
	const diffTime = now.getTime() - date.getTime();
	const diffDays = diffTime / (1000 * 3600 * 24);

	const nowDate = now.getDate();
	const nowMonth = now.getMonth();
	const nowYear = now.getFullYear();

	const dateDate = date.getDate();
	const dateMonth = date.getMonth();
	const dateYear = date.getFullYear();

	if (nowYear === dateYear && nowMonth === dateMonth && nowDate === dateDate) {
		return 'Today';
	} else if (nowYear === dateYear && nowMonth === dateMonth && nowDate - dateDate === 1) {
		return 'Yesterday';
	} else if (diffDays <= 7) {
		return 'Previous 7 days';
	} else if (diffDays <= 30) {
		return 'Previous 30 days';
	} else if (nowYear === dateYear) {
		return MONTH_NAMES[dateMonth];
	} else {
		return date.getFullYear().toString();
	}
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
		resolvedSchemas.add(schemaName);
		const referencedSchema = components.schemas[schemaName];
		return resolveSchema(referencedSchema, components, resolvedSchemas);
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
					schemaObj.properties[propName] = resolveSchema(propSchema, components);
				}
				break;

			case 'array':
				schemaObj.items = resolveSchema(schemaRef.items, components);
				break;

			default:
				// for primitive types (string, integer, etc.), just use as is
				break;
		}

		// Resolve composition keywords (oneOf, anyOf, allOf) which may contain $ref
		for (const keyword of ['oneOf', 'anyOf', 'allOf']) {
			if (Array.isArray(schemaRef[keyword])) {
				schemaObj[keyword] = schemaRef[keyword].map((inner: any) =>
					resolveSchema(inner, components, resolvedSchemas)
				);
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

// Valid HTTP methods per OpenAPI 3.x – used to skip extension keys (x-*)
// and non-operation path-item fields (summary, description, servers, parameters).
const OPENAPI_HTTP_METHODS = new Set([
	'get',
	'put',
	'post',
	'delete',
	'options',
	'head',
	'patch',
	'trace'
]);

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
		const pathLevelParams: any[] = Array.isArray((methods as any).parameters)
			? (methods as any).parameters
			: [];

		for (const [method, operation] of Object.entries(methods)) {
			if (!OPENAPI_HTTP_METHODS.has(method)) continue;
			if (!operation || typeof operation !== 'object') continue;
			if ((operation as any)?.operationId) {
				const tool: any = {
					name: (operation as any).operationId,
					description:
						(operation as any).description ||
						(operation as any).summary ||
						'No description available.',
					parameters: {
						type: 'object',
						properties: {} as Record<string, any>,
						required: [] as string[]
					}
				};

				// Merge path-level and operation-level parameters.
				// Operation-level params override path-level params with the
				// same (name, in) pair per the OpenAPI spec.
				const opParams: any[] = Array.isArray((operation as any).parameters)
					? (operation as any).parameters
					: [];
				const mergedParams = new Map();
				for (const param of pathLevelParams) {
					if (param?.name) mergedParams.set(`${param.name}:${param.in ?? ''}`, param);
				}
				for (const param of opParams) {
					if (param?.name) mergedParams.set(`${param.name}:${param.in ?? ''}`, param);
				}

				// Extract path and query parameters
				for (const param of mergedParams.values()) {
					const paramName = param?.name;
					if (!paramName) continue;
					const paramSchema = param?.schema ?? {};
					let description = paramSchema.description || param.description || '';
					if (paramSchema.enum && Array.isArray(paramSchema.enum)) {
						description += `. Possible values: ${paramSchema.enum.join(', ')}`;
					}
					tool.parameters.properties[paramName] = {
						type: paramSchema.type,
						description: description
					};

					if (param.required) {
						tool.parameters.required.push(paramName);
					}
				}

				// Extract and recursively resolve requestBody if available
				if ((operation as any).requestBody) {
					const content = (operation as any).requestBody.content;
					if (content && content['application/json']) {
						const requestSchema = content['application/json'].schema;
						const resolvedRequestSchema = resolveSchema(requestSchema, openApiSpec.components);

						if (resolvedRequestSchema.properties) {
							tool.parameters.properties = {
								...tool.parameters.properties,
								...resolvedRequestSchema.properties
							};

							if (resolvedRequestSchema.required) {
								tool.parameters.required = [
									...new Set([...tool.parameters.required, ...resolvedRequestSchema.required])
								];
							}
						} else if (resolvedRequestSchema.type === 'array') {
							tool.parameters = resolvedRequestSchema; // special case when root schema is an array
						}
					}
				}

				toolPayload.push(tool);
			}
		}
	}

	return toolPayload;
};
