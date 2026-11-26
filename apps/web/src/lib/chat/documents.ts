import type { ChatFile, Message } from '@/lib/chat/history';
import { replySegments } from '@/lib/chat/replySteps';
import { unescapeHtml } from '@/lib/markdown/content';
import { lexChat, lexMessage, type MdToken } from '@/lib/markdown/lexer';
import { alertOf, detailText } from '@/lib/markdown/markdownModel';

/**
 * What a chat gives the canvas to show (docs/plans/canvas.md): the files a
 * sandbox call left on a reply, the files the person attached, and the fenced
 * code blocks of a reply. Pure: messages in, documents out. Everything here
 * reads `message.files` and message text defensively, since an imported chat
 * or a plugin's event can put anything there.
 */

export type DocumentKind = 'html' | 'markdown' | 'code' | 'csv' | 'image' | 'pdf' | 'download';
// An SVG file is kind 'image' (never inline, never framed). An svg CODE BLOCK is kind 'html', language 'svg'.

export type DocumentSource =
	| { type: 'output'; fileId: string; previews: { id: string; page: number }[] } // sandbox output
	| { type: 'upload'; fileId: string }
	| { type: 'block'; text: string; language: string; closed: boolean } // fenced block, text already in the message
	// A file of a knowledge base a reply cited: read-only, outside `chatDocuments`, opened as `file:<uuid>`.
	// `page` is the first cited page, from 1; `passages` are the excerpts the retrieval gave that reply.
	| { type: 'knowledge'; fileId: string; page?: number; passages: string[] };

export type CanvasDocument = {
	/** output/upload: the file UUID. block: `block:<messageId>:<n>`. knowledge: `file:<uuid>`. */
	id: string;
	/** output/upload: ChatFile.name (server-cleaned), never meta.sandbox_path. block: its <title>, else a generic name. */
	name: string;
	kind: DocumentKind;
	/** highlight.js language for 'code' | 'markdown' and for blocks. */
	language?: string;
	/** ChatFile.size; block: the UTF-8 length of its text; else null. */
	bytes: number | null;
	messageId: string;
	source: DocumentSource;
};

/** The longest a code block can be, in lines, and stay inline; a longer one is a document. */
export const INLINE_LINES = 15;

/** A file's id goes into a URL, so only a UUID is accepted. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Shape = { kind: DocumentKind; language?: string };

const BY_EXTENSION: Record<string, Shape> = {
	png: { kind: 'image' },
	jpg: { kind: 'image' },
	jpeg: { kind: 'image' },
	gif: { kind: 'image' },
	webp: { kind: 'image' },
	svg: { kind: 'image' },
	html: { kind: 'html' },
	htm: { kind: 'html' },
	xhtml: { kind: 'html' },
	md: { kind: 'markdown', language: 'markdown' },
	markdown: { kind: 'markdown', language: 'markdown' },
	pdf: { kind: 'pdf' },
	csv: { kind: 'csv' },
	tex: { kind: 'code', language: 'latex' },
	py: { kind: 'code', language: 'python' },
	r: { kind: 'code', language: 'r' },
	json: { kind: 'code', language: 'json' },
	txt: { kind: 'code', language: 'plaintext' },
	log: { kind: 'code', language: 'plaintext' },
	js: { kind: 'code', language: 'javascript' },
	mjs: { kind: 'code', language: 'javascript' },
	jsx: { kind: 'code', language: 'javascript' },
	ts: { kind: 'code', language: 'typescript' },
	tsx: { kind: 'code', language: 'typescript' },
	yaml: { kind: 'code', language: 'yaml' },
	yml: { kind: 'code', language: 'yaml' },
	toml: { kind: 'code', language: 'ini' },
	sh: { kind: 'code', language: 'bash' },
	sql: { kind: 'code', language: 'sql' },
	xml: { kind: 'code', language: 'xml' },
	css: { kind: 'code', language: 'css' },
	c: { kind: 'code', language: 'c' },
	cpp: { kind: 'code', language: 'cpp' },
	java: { kind: 'code', language: 'java' },
	go: { kind: 'code', language: 'go' },
	rs: { kind: 'code', language: 'rust' }
};

const BY_TYPE: Record<string, Shape> = {
	'image/png': { kind: 'image' },
	'image/jpeg': { kind: 'image' },
	'image/gif': { kind: 'image' },
	'image/webp': { kind: 'image' },
	'image/svg+xml': { kind: 'image' },
	'text/html': { kind: 'html' },
	'application/xhtml+xml': { kind: 'html' },
	'text/markdown': { kind: 'markdown', language: 'markdown' },
	'text/x-markdown': { kind: 'markdown', language: 'markdown' },
	'application/pdf': { kind: 'pdf' },
	'text/csv': { kind: 'csv' },
	'application/json': { kind: 'code', language: 'json' },
	'text/x-python': { kind: 'code', language: 'python' },
	'text/x-tex': { kind: 'code', language: 'latex' },
	'text/plain': { kind: 'code', language: 'plaintext' }
};

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object';

const metaOf = (f: ChatFile): Record<string, unknown> => (isObject(f.meta) ? f.meta : {});

export const byteLength = (s: string) => new TextEncoder().encode(s).length;

/**
 * How a file is shown: by its name's extension, else by its stored media type
 * (the file's own `content_type`, then `meta.content_type`), else as a
 * download. A sandbox output's `sandbox_path` stands in for a missing name.
 */
export function documentKind(f: ChatFile, from: 'output' | 'upload'): Shape {
	const name = str(f.name) || (from === 'output' ? str(metaOf(f).sandbox_path) : undefined) || '';
	const dot = name.lastIndexOf('.');
	const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
	const type = (str(f.content_type) ?? str(metaOf(f).content_type) ?? '').split(';')[0].trim().toLowerCase();
	return BY_EXTENSION[extension] ?? BY_TYPE[type] ?? { kind: 'download' };
}

const COMPLETE_DOC = /^\s*(<!doctype\b|<html\b)/i;
const COMPLETE_SVG_START = /^\s*(<\?xml[^>]*>\s*)?<svg\b/i;
const COMPLETE_SVG_END = /<\/svg>\s*$/i;

/**
 * Whether a fenced block is a document, not just a snippet: a complete html
 * page or svg drawing, or anything of more than INLINE_LINES lines. Only the
 * second test applies to a language that is not html or svg.
 */
export function qualifies(code: string, language: string): boolean {
	if (code.split('\n').length > INLINE_LINES) return true;
	if (language === 'html') return COMPLETE_DOC.test(code);
	if (language === 'svg')
		return COMPLETE_DOC.test(code) || (COMPLETE_SVG_START.test(code) && COMPLETE_SVG_END.test(code));
	return false;
}

/** An svg snippet is shown centred on an otherwise empty page; html is used as written. */
export const blockDocument = (code: string) =>
	/^\s*<svg[\s>]/i.test(code)
		? `<!doctype html><html><body style="margin:0;display:grid;place-items:center;min-height:100vh">${code}</body></html>`
		: code;

const FENCED = /(```|~~~)\s*$/;

/** The text of a `details` block the renderer shows as Markdown, or null when it shows none (a tool call, an empty body). */
export function detailsBody(token: MdToken): string | null {
	if ((token.attributes?.type ?? '') === 'tool_calls') return null;
	return detailText(token) ? unescapeHtml(token.text) : null;
}

/**
 * The fenced code blocks of a token list, in the order the renderer
 * (components/chat/markdown/Tokens.tsx `Blocks`) draws them, whatever their
 * language. It visits every container `Blocks` recurses into: list items,
 * blockquotes (a GitHub alert's body is re-lexed from its text), `details`
 * bodies (re-lexed, except a tool call's), and `colonFence` contents. Indented
 * code is not fenced and is not a block here, as it is not a code block there.
 */
export function codeBlocks(tokens: MdToken[]): MdToken[] {
	const out: MdToken[] = [];
	for (const t of tokens ?? []) {
		if (!isObject(t)) continue;
		switch (t.type) {
			case 'code':
				if (typeof t.raw === 'string' && (t.raw.includes('```') || t.raw.includes('~~~'))) out.push(t);
				break;
			case 'list':
				for (const item of Array.isArray(t.items) ? t.items : []) out.push(...codeBlocks(item?.tokens));
				break;
			case 'blockquote': {
				const alert = alertOf(t);
				out.push(...codeBlocks(alert ? alert.tokens : t.tokens));
				break;
			}
			case 'details': {
				const body = detailsBody(t);
				if (body !== null) out.push(...codeBlocks(lexChat(body)));
				break;
			}
			case 'colonFence':
				out.push(...codeBlocks(t.tokens ?? []));
				break;
		}
	}
	return out;
}

/** The first word of a fence's info string, lower-cased: `python title=x` is `python`. */
const fenceLanguage = (token: MdToken) =>
	(typeof token.lang === 'string' ? token.lang : '').trim().split(/\s+/)[0].toLowerCase();

/** The texts a message shows as Markdown, in order: what `ChatMessages` renders. */
function messageTexts(m: Message): string[] {
	if (Array.isArray(m.output) && m.output.length) {
		return replySegments(m.output, m.done !== false).flatMap((s) => (s.type === 'text' ? [s.text] : []));
	}
	return [typeof m.content === 'string' ? m.content : ''];
}

const GENERIC_NAME: Record<string, string> = { html: 'HTML page', svg: 'SVG drawing' };

const titleOf = (text: string) => {
	const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text);
	// Control and format characters are dropped, as the server does for a file's name.
	const title = (m?.[1] ?? '')
		.replace(/[\p{Cc}\p{Cf}]/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	return title.length > 80 ? `${title.slice(0, 79)}…` : title;
};

const blockName = (text: string, language: string) => {
	if (language === 'html' || language === 'svg') return titleOf(text) || GENERIC_NAME[language];
	return language && language !== 'plaintext' && language !== 'text' ? `${language} code` : 'Code';
};

function blockDocuments(m: Message): CanvasDocument[] {
	const texts = messageTexts(m);
	const docs: CanvasDocument[] = [];
	const names = new Map<string, number>();
	let ordinal = 0;
	for (const text of texts) {
		for (const token of codeBlocks(lexMessage(text, m.modelName))) {
			// Every fenced block takes an ordinal, a document or not, so a block's id
			// does not change when it grows past the threshold while streaming.
			const n = ordinal++;
			const language = fenceLanguage(token);
			const code = typeof token.text === 'string' ? token.text : '';
			if (!qualifies(code, language)) continue;
			const markup = language === 'html' || language === 'svg';
			const base = blockName(code, language);
			const seen = (names.get(base) ?? 0) + 1;
			names.set(base, seen);
			docs.push({
				id: `block:${m.id}:${n}`,
				name: seen > 1 ? `${base} (${seen})` : base,
				kind: markup ? 'html' : 'code',
				language: language || 'plaintext',
				bytes: byteLength(code),
				messageId: m.id,
				source: {
					type: 'block',
					text: code,
					language: language || 'plaintext',
					closed: FENCED.test(token.raw ?? '') || m.done !== false
				}
			});
		}
	}
	return docs;
}

function fileDocuments(m: Message): CanvasDocument[] {
	const files = (Array.isArray(m.files) ? m.files : []).filter(
		(f): f is ChatFile & { id: string } => isObject(f) && UUID.test(str(f.id) ?? '')
	);
	const assistant = m.role === 'assistant';
	const shaped = files.flatMap((f) => {
		const output = metaOf(f).source === 'sandbox_output';
		// An assistant's file is shown only when the sandbox left it; a person's attachment is an upload.
		if (assistant !== output) return [];
		return [
			{ f, from: output ? ('output' as const) : ('upload' as const), ...documentKind(f, output ? 'output' : 'upload') }
		];
	});
	const previewOf = (f: ChatFile) => str(metaOf(f).preview_of);
	const pdfs = new Set(shaped.filter((s) => !previewOf(s.f) && s.kind === 'pdf').map((s) => s.f.id));
	const previews = new Map<string, { id: string; page: number }[]>();
	const attached = new Set<string>();
	for (const s of shaped) {
		const of = previewOf(s.f);
		if (!of || !pdfs.has(of) || s.f.id === of) continue;
		const page = metaOf(s.f).preview_page;
		previews.set(of, [...(previews.get(of) ?? []), { id: s.f.id, page: typeof page === 'number' ? page : 0 }]);
		attached.add(s.f.id);
	}
	for (const pages of previews.values()) pages.sort((a, b) => a.page - b.page);
	return shaped
		.filter((s) => !attached.has(s.f.id))
		.map(({ f, from, kind, language }) => {
			const size = f.size;
			const doc: CanvasDocument = {
				id: f.id,
				name: str(f.name) || (from === 'output' ? 'output' : 'file'),
				kind,
				bytes: typeof size === 'number' && Number.isFinite(size) && size >= 0 ? size : null,
				messageId: m.id,
				source:
					from === 'output'
						? { type: 'output', fileId: f.id, previews: previews.get(f.id) ?? [] }
						: { type: 'upload', fileId: f.id }
			};
			if (language) doc.language = language;
			return doc;
		});
}

const memo = new WeakMap<Message, CanvasDocument[]>();

/**
 * One message's documents: its fenced blocks (a reply's only) in text order,
 * then its files. Memoised per Message object, so a streaming token re-lexes
 * only the message it changed.
 */
export function messageDocuments(m: Message): CanvasDocument[] {
	if (!isObject(m)) return [];
	let docs = memo.get(m);
	if (!docs) {
		docs = [...(m.role === 'assistant' ? blockDocuments(m) : []), ...fileDocuments(m)];
		memo.set(m, docs);
	}
	return docs;
}

/** Every document of a branch, oldest message first; a file that appears twice is listed once. */
export function chatDocuments(messages: Message[]): CanvasDocument[] {
	const seen = new Set<string>();
	const out: CanvasDocument[] = [];
	for (const m of Array.isArray(messages) ? messages : []) {
		for (const d of messageDocuments(m)) {
			if (seen.has(d.id)) continue;
			seen.add(d.id);
			out.push(d);
		}
	}
	return out;
}

/** Whether a document counts toward opening the canvas by itself: outputs and html or svg blocks, not uploads or code. */
export const countsForAutoOpen = (d: CanvasDocument) =>
	d.source.type === 'output' || (d.source.type === 'block' && d.kind === 'html');

/** The address form of a knowledge file (`?canvas=file:<uuid>`); the id inside is a UUID, as for every file. */
export const KNOWLEDGE_ID = /^file:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * The file a retrieved passage came from, or null when it is not a knowledge file: a web page, a note
 * and a chat (whose metadata has a `file_id` that is theirs, and no `source`) are not.
 */
export function knowledgeFileId(metadata: unknown): string | null {
	if (!isObject(metadata)) return null;
	const id = str(metadata.file_id);
	const source = str(metadata.source);
	if (id === undefined || !UUID.test(id) || !source || /^https?:\/\//i.test(source)) return null;
	return id;
}

/**
 * The knowledge file `fileId` as a document, when a message of the branch cited it, else null: the
 * address alone never makes a file openable (the server still checks access on every fetch). A file
 * that is already one of the chat's own documents (an upload, an output) is that document. The
 * passages are those of the first reply that cited it.
 */
export function knowledgeDocument(
	messages: Message[],
	fileId: string,
	documents: CanvasDocument[]
): CanvasDocument | null {
	if (!UUID.test(fileId)) return null;
	const own = documents.find((d) => d.id === fileId);
	for (const m of Array.isArray(messages) ? messages : []) {
		if (!isObject(m) || !Array.isArray(m.sources)) continue;
		const passages: string[] = [];
		let name: string | undefined;
		let type: string | undefined;
		let page: number | undefined;
		for (const source of m.sources) {
			if (!isObject(source) || !Array.isArray(source.document) || !Array.isArray(source.metadata)) continue;
			source.document.forEach((passage, i) => {
				const metadata: unknown = source.metadata?.[i];
				if (knowledgeFileId(metadata) !== fileId || !isObject(metadata)) return;
				name ??= str(metadata.name) ?? str(metadata.source);
				type ??= str(metadata.content_type);
				const at = metadata.page;
				if (page === undefined && typeof at === 'number' && Number.isInteger(at) && at >= 0) page = at + 1;
				if (typeof passage === 'string' && passage) passages.push(passage);
			});
		}
		if (name === undefined) continue;
		if (own) return own;
		const file: ChatFile = { name, ...(type ? { content_type: type } : {}) };
		const { kind, language } = documentKind(file, 'upload');
		const doc: CanvasDocument = {
			id: `file:${fileId}`,
			name,
			kind,
			bytes: null,
			messageId: m.id,
			source: { type: 'knowledge', fileId, ...(page === undefined ? {} : { page }), passages }
		};
		if (language) doc.language = language;
		return doc;
	}
	return null;
}
