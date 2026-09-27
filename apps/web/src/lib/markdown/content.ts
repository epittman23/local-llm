import { WEBUI_BASE_URL } from '@/lib/constants';

// The text preprocessors a chat message goes through before it is tokenized,
// and the <details> helpers used when a message is sent back to a model.
// Ported from apps/openwebui/src/lib/utils/index.ts.

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Applies `replacer` to everything outside code spans and fences. */
export const replaceOutsideCode = (content: string, replacer: (s: string) => string) =>
	content
		.split(/(```[\s\S]*?```|`[\s\S]*?`)/)
		.map((segment) => (segment.startsWith('```') || segment.startsWith('`') ? segment : replacer(segment)))
		.join('');

/** `{{char}}`, `{{user}}` and the file placeholders a response may contain. */
export function replaceTokens(content: string, char?: string, user?: string): string {
	if (!content.includes('{{')) return content;
	const tokens: [RegExp, string | ((m: string, id: string) => string) | undefined][] = [
		[/{{char}}/gi, char],
		[/{{user}}/gi, user],
		[/{{VIDEO_FILE_ID_([a-f0-9-]+)}}/gi, (_, id) => `<video src="${WEBUI_BASE_URL}/api/v1/files/${id}/content" controls></video>`],
		[/{{HTML_FILE_ID_([a-f0-9-]+)}}/gi, (_, id) => `<file type="html" id="${id}" />`]
	];
	return replaceOutsideCode(content, (segment) => {
		for (const [regex, replacement] of tokens) {
			if (replacement !== undefined && replacement !== null) segment = segment.replace(regex, replacement as never);
		}
		return segment;
	});
}

const isChineseChar = (c: string) => /\p{Script=Han}/u.test(c);

function processChineseDelimiters(line: string, symbol: string, leftSymbol: string, rightSymbol: string): string {
	const s = escapeRegExp(symbol);
	const regex = new RegExp(`(.?)(?<!${s})(${s})([^${s}]+)(${s})(?!${s})(.)`, 'g');
	return line.replace(regex, (match, l: string, left: string, content: string, right: string, r: string) => {
		const pad = (content.startsWith(leftSymbol) && l && isChineseChar(l[l.length - 1])) || (content.endsWith(rightSymbol) && r && isChineseChar(r[0]));
		return pad ? `${l} ${left}${content}${right} ${r}` : match;
	});
}

/** Bold/italic next to full-width brackets or quotes is not recognised by Markdown; spacing it out fixes that. */
function processChineseContent(content: string): string {
	if (!/[一-龥]/.test(content)) return content;
	return content
		.split('\n')
		.map((line) => {
			if (!/[一-龥]/.test(line) || !line.includes('*')) return line;
			if (/（|）/.test(line)) {
				line = processChineseDelimiters(line, '**', '（', '）');
				line = processChineseDelimiters(line, '*', '（', '）');
			}
			if (/“|”/.test(line)) {
				line = processChineseDelimiters(line, '**', '“', '”');
				line = processChineseDelimiters(line, '*', '“', '”');
			}
			return line;
		})
		.join('\n');
}

export const processResponseContent = (content: string) => processChineseContent(content).trim();

/** HTML entities to text, without executing anything (a parsed, inert document). */
export function unescapeHtml(html: string): string {
	if (!html || !html.includes('&')) return html ?? '';
	return new DOMParser().parseFromString(`<!doctype html><body>${html.replace(/</g, '&lt;')}`, 'text/html').body.textContent ?? '';
}

export const removeDetails = (content: string, types: string[]) =>
	replaceOutsideCode(content, (segment) => {
		for (const type of types) segment = segment.replace(new RegExp(`<details\\s+type="${type}"[^>]*>.*?<\\/details>`, 'gis'), '');
		return segment;
	}).trim();

/** A message with every <details> block (reasoning, tool calls, ...) removed: what is copied or read aloud. */
export function removeAllDetails(content: string): string {
	content = content.replace(/<details[^>]*>[\s\S]*?<\/details>/gi, '');
	return replaceOutsideCode(content, (segment) => segment.replace(/<details[^>]*>.*?<\/details>/gis, '')).trim();
}

/**
 * What a model sees of an earlier reply: reasoning and code-interpreter blocks
 * dropped, each tool-call block replaced by its result.
 */
export function processDetails(content: string): string {
	content = removeDetails(content, ['reasoning', 'code_interpreter']);
	const matches = content.match(/<details\s+type="tool_calls"([^>]*)>([\s\S]*?)<\/details>/gis);
	for (const match of matches ?? []) {
		const attributes: Record<string, string> = {};
		for (const [, k, v] of match.matchAll(/(\w+)="([^"]*)"/g)) attributes[k] = v;
		let result = '';
		if (attributes.result) result = unescapeHtml(attributes.result);
		else {
			const body = match.match(/<summary>[\s\S]*?<\/summary>\s*([\s\S]*?)\s*<\/details>/i);
			if (body?.[1].trim()) result = unescapeHtml(body[1].trim());
		}
		if (result) content = content.replace(match, result);
	}
	return content;
}
