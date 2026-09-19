// Ports parseFrontmatter / formatSkillName from
// apps/openwebui/src/lib/utils/index.ts (the skills editor and import use them).

/**
 * Reads the `key: value` lines of a leading `---` block. Values lose one pair of
 * surrounding quotes. Returns a prototype-less object: the original builds a plain
 * `{}` and assigns `frontmatter[key]`, so a file with a `__proto__:` line would
 * write to the object's prototype rather than a property.
 */
export const parseFrontmatter = (content: string): Record<string, string> => {
	const result: Record<string, string> = Object.create(null);
	const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
	if (!match) return result;
	for (const line of match[1].split('\n')) {
		const [key, ...value] = line.split(':');
		if (key && value) {
			result[key.trim()] = value
				.join(':')
				.trim()
				.replace(/^["']|["']$/g, '');
		}
	}
	return result;
};

/** "code-review_guide" -> "Code Review Guide". */
export const formatSkillName = (name: string): string =>
	name.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
