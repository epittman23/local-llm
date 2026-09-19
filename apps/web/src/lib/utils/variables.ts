// Prompt-variable parsing ({{name | type:input, ...}}), ported verbatim from
// apps/openwebui/src/lib/utils/index.ts. The model editor's "Detected Variables"
// preview reads it; the chat input (Phase 10) will too.

export const extractInputVariables = (text: string): Record<string, any> => {
	const regex = /{{\s*([^|}\s]+)\s*\|\s*([^}]+)\s*}}/g;
	const regularRegex = /{{\s*([^|}\s]+)\s*}}/g;
	const variables: Record<string, any> = {};
	let match;
	// Use exec() loop instead of matchAll() for better compatibility
	while ((match = regex.exec(text)) !== null) {
		const varName = match[1].trim();
		const definition = match[2].trim();
		variables[varName] = parseVariableDefinition(definition);
	}
	// Then, extract regular variables (without pipe) - only if not already processed
	while ((match = regularRegex.exec(text)) !== null) {
		const varName = match[1].trim();
		// Only add if not already processed as custom variable
		if (!variables.hasOwnProperty(varName)) {
			variables[varName] = { type: 'text' }; // Default type for regular variables
		}
	}
	return variables;
};

export const splitProperties = (str: string, delimiter: string): string[] => {
	const result: string[] = [];
	let current = '';
	let depth = 0;
	let inString = false;
	let escapeNext = false;

	for (let i = 0; i < str.length; i++) {
		const char = str[i];

		if (escapeNext) {
			current += char;
			escapeNext = false;
			continue;
		}

		if (char === '\\') {
			current += char;
			escapeNext = true;
			continue;
		}

		if (char === '"' && !escapeNext) {
			inString = !inString;
			current += char;
			continue;
		}

		if (!inString) {
			if (char === '{' || char === '[') {
				depth++;
			} else if (char === '}' || char === ']') {
				depth--;
			}

			if (char === delimiter && depth === 0) {
				result.push(current.trim());
				current = '';
				continue;
			}
		}

		current += char;
	}

	if (current.trim()) {
		result.push(current.trim());
	}

	return result;
};

export const parseVariableDefinition = (definition: string): Record<string, any> => {
	// Use splitProperties for the main colon delimiter to handle quoted strings
	const parts = splitProperties(definition, ':');
	const [firstPart, ...propertyParts] = parts;

	// Parse type (explicit or implied)
	const type = firstPart.startsWith('type=') ? firstPart.slice(5) : firstPart;

	// Parse properties; support both key=value and bare flags (e.g., ":required")
	const properties = propertyParts.reduce(
		(props, part) => {
			const trimmed = part.trim();
			if (!trimmed) return props;

			// Use splitProperties for the equals sign as well, in case there are nested quotes
			const equalsParts = splitProperties(trimmed, '=');

			if (equalsParts.length === 1) {
				// It's a flag with no value, e.g. "required" -> true
				const flagName = equalsParts[0].trim();
				if (flagName.length > 0) {
					return { ...props, [flagName]: true };
				}
				return props;
			}

			const [propertyName, ...valueParts] = equalsParts;
			const propertyValueRaw = valueParts.join('='); // Handle values with extra '='

			if (!propertyName || propertyValueRaw == null) return props;

			return {
				...props,
				[propertyName.trim()]: parseJsonValue(propertyValueRaw.trim())
			};
		},
		{} as Record<string, any>
	);

	return { type, ...properties };
};

export const parseJsonValue = (value: string): any => {
	// Remove surrounding quotes if present (for string values)
	if (value.startsWith('"') && value.endsWith('"')) {
		return value.slice(1, -1);
	}

	// Check if it starts with square or curly brackets (JSON)
	if (/^[\[{]/.test(value)) {
		try {
			return JSON.parse(value);
		} catch {
			return value; // Return as string if JSON parsing fails
		}
	}

	return value;
};
