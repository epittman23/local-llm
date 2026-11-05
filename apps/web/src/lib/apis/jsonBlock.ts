/**
 * The JSON object a model's reply holds, or null when it holds none that
 * parses: the text from its first `{` to its last `}`.
 *
 * The block is parsed as written first. Only if that fails are single and
 * curly quotes turned into double ones and the block tried again, for models
 * that answer `{'tags': ['x']}`. Doing that first broke every reply with an
 * apostrophe inside a value, such as "Student's t-test" (#306).
 */
export function parseJsonBlock(reply: string): Record<string, unknown> | null {
	const parse = (text: string) => {
		const start = text.indexOf('{');
		const end = text.lastIndexOf('}');
		if (start === -1 || end < start) return null;
		try {
			const parsed: unknown = JSON.parse(text.slice(start, end + 1));
			return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
				? (parsed as Record<string, unknown>)
				: null;
		} catch {
			return null;
		}
	};
	return parse(reply) ?? parse(reply.replace(/['‘’`]/g, '"'));
}
