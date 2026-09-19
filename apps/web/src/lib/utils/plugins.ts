// Helpers shared by the Tools (and, in Phase 8, Functions) editors. Ported from
// apps/openwebui/src/lib/utils/index.ts.

/**
 * Reads the `key: value` header of a plugin's source: a leading `"""` line,
 * then `key: value` lines, closed by the next line containing `"""`. Returns {}
 * if the file does not open with a bare `"""`. Prototype-less for the same
 * reason as `parseFrontmatter` in skills.ts.
 */
export const extractFrontmatter = (content: string): Record<string, string> => {
	const result: Record<string, string> = Object.create(null);
	const lines = content.split('\n');
	if (lines[0].trim() !== '"""') return result;

	const pattern = /^\s*([a-z_]+):\s*(.*)\s*$/i;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].includes('"""')) break;
		const match = pattern.exec(lines[i]);
		if (match) result[match[1].trim()] = match[2].trim();
	}
	return result;
};

/**
 * True when `current` is older than `latest` (i.e. the app is too old for what
 * a plugin requires). A `current` of 0.0.0 means "unknown build" and never blocks.
 */
export const compareVersion = (latest: string, current: string): boolean =>
	current === '0.0.0'
		? false
		: current.localeCompare(latest, undefined, {
				numeric: true,
				sensitivity: 'case',
				caseFirst: 'upper'
			}) < 0;

/** "My Tool 😄" -> "my_tool": a backend-safe identifier from a display name. */
export const nameToId = (name: string): string =>
	name
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/[^\w]+/g, '_')
		.replace(/^_+|_+$/g, '')
		.toLowerCase();
