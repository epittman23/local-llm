import { describe, expect, it } from 'vitest';
import type { ChatFile, Message } from './history';
import {
	blockDocument,
	byteLength,
	chatDocuments,
	codeBlocks,
	countsForAutoOpen,
	documentKind,
	KNOWLEDGE_ID,
	knowledgeDocument,
	knowledgeFileId,
	messageDocuments,
	qualifies,
	UUID
} from './documents';
import { lexMessage } from '@/lib/markdown/lexer';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const out = (n: number, name: string, extra: Partial<ChatFile> = {}, meta: Record<string, unknown> = {}): ChatFile => ({
	type: 'file',
	id: id(n),
	name,
	size: 10,
	meta: { source: 'sandbox_output', sandbox_path: name, ...meta },
	...extra
});

const msg = (over: Partial<Message> = {}): Message =>
	({ id: 'm1', parentId: null, childrenIds: [], role: 'assistant', content: '', done: true, ...over }) as Message;

const lines = (n: number, line = 'x') => Array.from({ length: n }, () => line).join('\n');
const fence = (lang: string, body: string, ticks = '```') => `${ticks}${lang}\n${body}\n${ticks}`;
const page = '<!doctype html><title>Hi there</title><p>x</p>';

describe('documentKind', () => {
	it('picks by extension, then by stored type, else a download', () => {
		const kind = (name: string, extra: Partial<ChatFile> = {}, meta: Record<string, unknown> = {}) =>
			documentKind({ name, ...extra, meta }, 'output');
		expect(kind('a.PNG').kind).toBe('image');
		expect(kind('a.gif').kind).toBe('image');
		expect(kind('a.webp').kind).toBe('image');
		expect(kind('a.svg').kind).toBe('image');
		expect(kind('a.html').kind).toBe('html');
		expect(kind('a.htm').kind).toBe('html');
		expect(kind('a.pdf').kind).toBe('pdf');
		expect(kind('a.csv').kind).toBe('csv');
		expect(kind('a.md')).toEqual({ kind: 'markdown', language: 'markdown' });
		expect(kind('a.py')).toEqual({ kind: 'code', language: 'python' });
		expect(kind('a.ts')).toEqual({ kind: 'code', language: 'typescript' });
		expect(kind('a.tex')).toEqual({ kind: 'code', language: 'latex' });
		expect(kind('a.pkl').kind).toBe('download');
		expect(kind('noext').kind).toBe('download');
		expect(kind('.hidden').kind).toBe('download');
		// The extension wins over a stored type.
		expect(kind('a.png', {}, { content_type: 'text/html' }).kind).toBe('image');
		// No usable extension: the stored type, parameters stripped.
		expect(kind('blob', {}, { content_type: 'Text/HTML; charset=utf-8' }).kind).toBe('html');
		expect(kind('blob', {}, { content_type: 'application/json' })).toEqual({ kind: 'code', language: 'json' });
		expect(kind('blob', {}, { content_type: 'text/markdown' }).kind).toBe('markdown');
		// A top-level content_type is read before meta's.
		expect(kind('blob', { content_type: 'text/csv' }, { content_type: 'text/html' }).kind).toBe('csv');
	});

	it('falls back to sandbox_path for an output only', () => {
		const f = { meta: { sandbox_path: 'r/plot.png' } } as ChatFile;
		expect(documentKind(f, 'output').kind).toBe('image');
		expect(documentKind(f, 'upload').kind).toBe('download');
	});

	it('survives a non-string name and a meta that is not an object', () => {
		expect(documentKind({ name: 7 as never, meta: 'x' as never }, 'output').kind).toBe('download');
		expect(documentKind({ meta: null as never }, 'upload').kind).toBe('download');
	});
});

describe('files as documents', () => {
	it('shows nothing for files that are not sandbox outputs on a reply', () => {
		const m = msg({
			files: [
				{ type: 'file', id: id(1), name: 'a.png' },
				{ type: 'file', id: id(2), name: 'b.png', meta: { source: 'upload' } }
			]
		});
		expect(messageDocuments(m)).toEqual([]);
	});

	it('skips malformed entries and ids that are not UUIDs', () => {
		const files = [
			null,
			undefined,
			'x',
			7,
			[],
			{},
			out(1, 'ok.png', { id: 'not-a-uuid' }),
			out(2, 'ok.png', { id: '../etc/passwd' }),
			out(3, 'good.png')
		] as unknown as ChatFile[];
		expect(messageDocuments(msg({ files })).map((d) => d.name)).toEqual(['good.png']);
	});

	it('survives files that are not an array, a bad name, a bad size and a bad meta', () => {
		for (const files of [null, 'x', 5, {}, { length: 2 }]) {
			expect(messageDocuments(msg({ files: files as never }))).toEqual([]);
		}
		const docs = messageDocuments(
			msg({
				files: [
					out(1, 'x.png', { name: 5 as never, size: 'big' as never }, { sandbox_path: 'p/x.png' }),
					out(2, 'y.csv', { size: Number.NaN }),
					out(3, 'z.csv', { size: -4 })
				]
			})
		);
		expect(docs.map((x) => [x.name, x.kind, x.bytes])).toEqual([
			['output', 'image', null],
			['y.csv', 'csv', null],
			['z.csv', 'csv', null]
		]);
	});

	it('names an output by its cleaned name, never the raw path', () => {
		const [d] = messageDocuments(msg({ files: [out(1, 'report.pdf', {}, { sandbox_path: 'x‮fdp.exe' })] }));
		expect(d.name).toBe('report.pdf');
		expect(JSON.stringify(d)).not.toContain('‮');
	});

	it('groups PDF previews in page order, and an orphan preview is an image document', () => {
		const docs = messageDocuments(
			msg({
				files: [
					out(1, 'r.pdf'),
					out(3, 'r-2.png', {}, { preview_of: id(1), preview_page: 2 }),
					out(2, 'r-1.png', {}, { preview_of: id(1), preview_page: 1 }),
					out(4, 'gone-1.png', {}, { preview_of: id(9), preview_page: 1 }),
					out(5, 'chart.png', {}, { preview_of: id(6) }),
					out(6, 'plain.csv')
				]
			})
		);
		expect(docs.map((d) => [d.name, d.kind])).toEqual([
			['r.pdf', 'pdf'],
			['gone-1.png', 'image'],
			['chart.png', 'image'],
			['plain.csv', 'csv']
		]);
		expect(docs[0].source).toEqual({
			type: 'output',
			fileId: id(1),
			previews: [
				{ id: id(2), page: 1 },
				{ id: id(3), page: 2 }
			]
		});
	});

	it('does not attach previews to a file that is not a PDF', () => {
		const docs = messageDocuments(msg({ files: [out(1, 'a.csv'), out(2, 'p.png', {}, { preview_of: id(1) })] }));
		expect(docs.map((d) => d.name)).toEqual(['a.csv', 'p.png']);
	});

	it("lists a person's attachments with a UUID id as uploads; a pasted image is not a document", () => {
		const docs = messageDocuments(
			msg({
				role: 'user',
				content: 'hi',
				files: [
					{ type: 'file', id: id(1), name: 'page.html', content_type: 'text/html', size: 4 },
					{ type: 'image', url: 'data:image/png;base64,AAA' },
					{ type: 'image', id: null, url: 'data:image/png;base64,AAA' },
					{ type: 'file', id: id(2), name: 'data.csv' },
					{ type: 'image', id: id(3), name: 'photo.jpg' },
					{ type: 'file', id: id(4), name: 'x', meta: { source: 'sandbox_output' } }
				]
			})
		);
		expect(docs.map((d) => [d.name, d.kind, d.source.type])).toEqual([
			['page.html', 'html', 'upload'],
			['data.csv', 'csv', 'upload'],
			['photo.jpg', 'image', 'upload']
		]);
		expect(docs[0].source).toEqual({ type: 'upload', fileId: id(1) });
		expect(docs[0].bytes).toBe(4);
	});

	it('never shows an assistant file the sandbox did not leave', () => {
		expect(messageDocuments(msg({ files: [{ type: 'file', id: id(1), name: 'a.html' }] }))).toEqual([]);
	});
});

describe('qualifies', () => {
	it('takes a complete html page of any length', () => {
		expect(qualifies('<!doctype html><p>', 'html')).toBe(true);
		expect(qualifies('  \n<!DOCTYPE html>', 'html')).toBe(true);
		expect(qualifies('<html><body>x</body></html>', 'html')).toBe(true);
		expect(qualifies('<HTML lang=en>', 'html')).toBe(true);
		expect(qualifies('<htmlx>', 'html')).toBe(false);
		expect(qualifies('<div>hi</div>', 'html')).toBe(false);
	});

	it('takes fifteen lines never and sixteen always', () => {
		expect(qualifies(lines(15, '<p>x</p>'), 'html')).toBe(false);
		expect(qualifies(lines(16, '<p>x</p>'), 'html')).toBe(true);
		expect(qualifies(lines(15), 'python')).toBe(false);
		expect(qualifies(lines(16), 'python')).toBe(true);
		expect(qualifies(lines(16), '')).toBe(true);
	});

	it('takes a whole svg drawing, not a fragment', () => {
		expect(qualifies('<svg viewBox="0 0 1 1"><circle/></svg>', 'svg')).toBe(true);
		expect(qualifies('<?xml version="1.0"?>\n<svg><g/></svg>\n', 'svg')).toBe(true);
		expect(qualifies('<svg><circle/>', 'svg')).toBe(false);
		expect(qualifies('<circle/></svg>', 'svg')).toBe(false);
		expect(qualifies('<svg><g/></svg>', 'html')).toBe(false);
		expect(qualifies('<svg><g/></svg>', 'python')).toBe(false);
	});
});

describe('blocks as documents', () => {
	it('numbers every fenced block, qualifying or not, in text order', () => {
		const content = [
			'a',
			fence('html', '<b>1</b>'),
			fence('python', 'print(1)'),
			fence('html', page),
			fence('python', lines(16)),
			fence('svg', '<svg><g/></svg>')
		].join('\n\n');
		const docs = messageDocuments(msg({ content }));
		expect(docs.map((d) => d.id)).toEqual(['block:m1:2', 'block:m1:3', 'block:m1:4']);
		expect(docs.map((d) => [d.kind, d.language, d.name])).toEqual([
			['html', 'html', 'Hi there'],
			['code', 'python', 'python code'],
			['html', 'svg', 'SVG drawing']
		]);
		expect(docs[0].bytes).toBe(byteLength(page));
		expect(docs[0].source).toMatchObject({ type: 'block', language: 'html', text: page, closed: true });
	});

	it('names duplicates in one message with a number', () => {
		const content = [fence('html', page), fence('html', page), fence('html', '<!doctype html>')].join('\n\n');
		expect(messageDocuments(msg({ content })).map((d) => d.name)).toEqual(['Hi there', 'Hi there (2)', 'HTML page']);
	});

	it('gives a block the same id before and after it grows past 15 lines', () => {
		const withTail = (n: number) =>
			messageDocuments(msg({ content: `${fence('html', '<b>a</b>')}\n\n${fence('python', lines(n))}` }));
		expect(withTail(15)).toEqual([]);
		expect(withTail(16).map((d) => d.id)).toEqual(['block:m1:1']);
		// The block ahead of it grows past the line too: its own id is 0, the next still 1.
		const grown = messageDocuments(
			msg({ content: `${fence('html', lines(16, '<p/>'))}\n\n${fence('python', lines(16))}` })
		);
		expect(grown.map((d) => d.id)).toEqual(['block:m1:0', 'block:m1:1']);
	});

	it('survives a unusual message id with colons', () => {
		const d = messageDocuments(msg({ id: 'a:b:c', content: fence('html', page) }))[0];
		expect(d.id).toBe('block:a:b:c:0');
		expect(/^block:(.+):(\d+)$/.exec(d.id)?.slice(1)).toEqual(['a:b:c', '0']);
	});

	it('ignores indented code and inline code, and handles nested fences', () => {
		const content = [
			'    <!doctype html>\n    <p>indented</p>',
			'`<!doctype html>`',
			fence('markdown', `${fence('html', page)}`, '````'),
			fence('html', page, '~~~')
		].join('\n\n');
		const docs = messageDocuments(msg({ content }));
		// The html fence inside the outer four-backtick fence is text of the markdown block.
		expect(docs.map((d) => d.id)).toEqual(['block:m1:1']);
		expect(docs[0].source).toMatchObject({ language: 'html', closed: true });
	});

	it('reads the fence language as its first word, lower-cased', () => {
		const [d] = messageDocuments(msg({ content: fence('HTML title="x"', page) }));
		expect(d.kind).toBe('html');
		expect(d.language).toBe('html');
		const [p] = messageDocuments(msg({ content: fence('', lines(16)) }));
		expect([p.kind, p.language, p.name]).toEqual(['code', 'plaintext', 'Code']);
	});

	it('flags closed: an unclosed fence is open while streaming and closed once done', () => {
		const open = `intro\n\n\`\`\`html\n${page}\n<p>more`;
		const streaming = messageDocuments(msg({ content: open, done: false }))[0];
		expect(streaming.source).toMatchObject({ type: 'block', closed: false });
		const done = messageDocuments(msg({ content: open, done: true }))[0];
		expect(done.source).toMatchObject({ closed: true });
		const finished = messageDocuments(msg({ content: `${open}\n\`\`\``, done: false }))[0];
		expect(finished.source).toMatchObject({ closed: true });
		// done undefined counts as done, as ChatMessages treats it.
		expect(messageDocuments(msg({ content: open, done: undefined }))[0].source).toMatchObject({ closed: true });
	});

	it('treats a partial closing fence as still streaming', () => {
		const partial = messageDocuments(msg({ content: `\`\`\`html\n${page}\n\`\``, done: false }))[0];
		expect(partial.source).toMatchObject({ closed: false });
	});

	it("does not look in a person's message for blocks", () => {
		expect(messageDocuments(msg({ role: 'user', content: fence('html', page) }))).toEqual([]);
	});

	it("reads the reply's output texts, in order, when it has any", () => {
		const text = (t: string, i: number) => ({
			type: 'message',
			id: `t${i}`,
			content: [{ type: 'output_text', text: t }]
		});
		const m = msg({
			content: 'ignored: no fence here',
			output: [
				text(fence('python', 'a'), 0),
				{ type: 'function_call', id: 'f', call_id: 'c', name: 'bash', arguments: '{}' },
				{ type: 'function_call_output', call_id: 'c', output: [{ type: 'input_text', text: '{}' }] },
				text(fence('html', page), 1)
			] as never
		});
		expect(messageDocuments(m).map((d) => d.id)).toEqual(['block:m1:1']);
		// A block's ordinal continues across the text segments; an empty output falls back to content.
		expect(messageDocuments(msg({ output: [], content: fence('html', page) })).map((d) => d.id)).toEqual([
			'block:m1:0'
		]);
	});

	it('puts blocks before files within a message', () => {
		const docs = messageDocuments(msg({ content: fence('html', page), files: [out(1, 'a.csv')] }));
		expect(docs.map((d) => d.source.type)).toEqual(['block', 'output']);
	});
});

describe('the walker finds the blocks the renderer draws', () => {
	const ids = (content: string) => messageDocuments(msg({ content })).map((d) => d.id);
	const html = fence('html', page);
	const indent = (s: string, pad: string) =>
		s
			.split('\n')
			.map((l) => `${pad}${l}`)
			.join('\n');

	it('in a list item, bullet or numbered, and a task item', () => {
		expect(ids(`- one\n\n${indent(html, '  ')}\n- two`)).toEqual(['block:m1:0']);
		expect(ids(`1. one\n\n${indent(html, '   ')}\n\n2. two\n\n${indent(html, '   ')}`)).toEqual([
			'block:m1:0',
			'block:m1:1'
		]);
		expect(ids(`- [ ] task\n\n${indent(html, '  ')}`)).toEqual(['block:m1:0']);
	});

	it('in a nested list inside a blockquote', () => {
		expect(ids(`> - item\n>\n>   ${html.split('\n').join('\n>   ')}`)).toEqual(['block:m1:0']);
	});

	it('in a blockquote', () => {
		expect(
			ids(
				`> quote\n>\n${html
					.split('\n')
					.map((l) => `> ${l}`)
					.join('\n')}`
			)
		).toEqual(['block:m1:0']);
	});

	it('in a GitHub alert', () => {
		const alert = `> [!NOTE]\n> look\n>\n${html
			.split('\n')
			.map((l) => `> ${l}`)
			.join('\n')}`;
		expect(ids(alert)).toEqual(['block:m1:0']);
	});

	it('in a details body, but not in a tool call', () => {
		expect(ids(`<details>\n<summary>More</summary>\n\n${html}\n\n</details>\n\n${html}`)).toEqual([
			'block:m1:0',
			'block:m1:1'
		]);
		const call = `<details type="tool_calls" done="true" id="c" name="n" arguments="{}" result="&quot;${html.replace(/"/g, '&quot;')}&quot;">\n<summary>Tool Executed</summary>\n</details>`;
		expect(ids(`${call}\n\n${html}`)).toEqual(['block:m1:0']);
	});

	it('in a colon fence', () => {
		expect(ids(`:::note\n${html}\n:::`)).toEqual(['block:m1:0']);
	});

	it('in an order that matches the renderer: container blocks keep their place between siblings', () => {
		const a = fence('python', 'a');
		const content = `${a}\n\n- item\n\n${indent(fence('html', page), '  ')}\n\n> q\n>\n${fence('svg', '<svg><g/></svg>')
			.split('\n')
			.map((l) => `> ${l}`)
			.join('\n')}\n\n${fence('css', 'b{}')}`;
		const tokens = lexMessage(content);
		expect(codeBlocks(tokens).map((t) => t.lang)).toEqual(['python', 'html', 'svg', 'css']);
	});

	it('hostile token lists do not throw', () => {
		const hostile = [
			null,
			3,
			{},
			{ type: 'list' },
			{ type: 'list', items: [null, {}] },
			{ type: 'blockquote' },
			{ type: 'code' },
			{ type: 'details' }
		] as never;
		expect(codeBlocks(hostile)).toEqual([]);
		expect(codeBlocks(undefined as never)).toEqual([]);
	});
});

describe('chatDocuments', () => {
	it('lists oldest to newest, a file once', () => {
		const a = msg({ id: 'a', files: [out(1, 'a.csv')] });
		const b = msg({ id: 'b', content: fence('html', page), files: [out(1, 'a.csv'), out(2, 'b.csv')] });
		expect(chatDocuments([a, b]).map((d) => d.id)).toEqual([id(1), 'block:b:0', id(2)]);
	});

	it('follows the branch it is given', () => {
		const q = msg({ id: 'q', role: 'user', content: 'hi' });
		const x = msg({ id: 'x', parentId: 'q', content: fence('html', page) });
		const y = msg({ id: 'y', parentId: 'q', files: [out(5, 'y.csv')] });
		expect(chatDocuments([q, x]).map((d) => d.id)).toEqual(['block:x:0']);
		expect(chatDocuments([q, y]).map((d) => d.id)).toEqual([id(5)]);
	});

	it('tolerates non-arrays and bad messages', () => {
		expect(chatDocuments(null as never)).toEqual([]);
		expect(chatDocuments([null, 4, msg({ files: [out(1, 'a.csv')] })] as never).map((d) => d.id)).toEqual([id(1)]);
	});

	it('re-lexes only the message that changed', () => {
		const a = msg({ id: 'a', content: fence('html', page) });
		const first = messageDocuments(a);
		expect(messageDocuments(a)).toBe(first);
		expect(messageDocuments({ ...a })).not.toBe(first);
	});
});

describe('countsForAutoOpen', () => {
	it('counts outputs and html or svg blocks, not code blocks or uploads', () => {
		const docs = messageDocuments(
			msg({ content: `${fence('html', page)}\n\n${fence('python', lines(16))}`, files: [out(1, 'a.csv')] })
		);
		expect(docs.filter(countsForAutoOpen).map((d) => d.kind)).toEqual(['html', 'csv']);
		const [upload] = messageDocuments(msg({ role: 'user', files: [{ type: 'file', id: id(2), name: 'a.html' }] }));
		expect(countsForAutoOpen(upload)).toBe(false);
	});
});

describe('blockDocument', () => {
	it('wraps a bare svg on a centred page and leaves html alone', () => {
		const svg = '<svg viewBox="0 0 1 1"><circle r="1"/></svg>';
		expect(blockDocument(svg)).toContain('place-items:center');
		expect(blockDocument(`  \n${svg}`)).toContain(svg);
		expect(blockDocument(page)).toBe(page);
		expect(blockDocument('<svgx>')).toBe('<svgx>');
	});
});

describe('UUID', () => {
	it('accepts a UUID and nothing that could change a URL', () => {
		expect(UUID.test(id(1))).toBe(true);
		expect(UUID.test(`${id(1)}/../x`)).toBe(false);
		expect(UUID.test('')).toBe(false);
	});
});

describe('knowledge files', () => {
	const file = id(77);
	const cited = (metadata: unknown[], document: unknown[] = ['a passage']) =>
		msg({ sources: [{ source: { name: 'notes.md' }, document, metadata }] } as unknown as Partial<Message>);
	const reply = cited([{ file_id: file, name: 'notes.md', source: 'notes.md', page: 2 }], ['first']);

	it('knows a file by a UUID file_id and a source that is not a URL; a note, a chat and a web page are not', () => {
		expect(knowledgeFileId({ file_id: file, source: 'notes.md' })).toBe(file);
		expect(knowledgeFileId({ file_id: file, name: 'A note' })).toBeNull();
		expect(knowledgeFileId({ file_id: file, source: 'https://a.example/x' })).toBeNull();
		expect(knowledgeFileId({ file_id: 'not-a-uuid', source: 'a.md' })).toBeNull();
		expect(knowledgeFileId({ file_id: `${file}/../x`, source: 'a.md' })).toBeNull();
		expect(knowledgeFileId(null)).toBeNull();
		expect(knowledgeFileId('text')).toBeNull();
	});

	it('is addressed as file:<uuid>', () => {
		expect(KNOWLEDGE_ID.exec(`file:${file}`)?.[1]).toBe(file);
		expect(KNOWLEDGE_ID.test(`file:${file}/x`)).toBe(false);
		expect(KNOWLEDGE_ID.test('file:abc')).toBe(false);
		expect(KNOWLEDGE_ID.test(file)).toBe(false);
	});

	it('resolves only a file the branch cites, as a read-only document with its passages and first page', () => {
		const doc = knowledgeDocument([reply], file, []);
		expect(doc).toMatchObject({ id: `file:${file}`, name: 'notes.md', kind: 'markdown', messageId: 'm1', bytes: null });
		expect(doc?.source).toEqual({ type: 'knowledge', fileId: file, page: 3, passages: ['first'] });
		expect(knowledgeDocument([reply], id(78), [])).toBeNull();
		expect(knowledgeDocument([], file, [])).toBeNull();
		expect(knowledgeDocument([reply], 'file:nope', [])).toBeNull();
	});

	it('is not one of the chat’s documents', () => {
		expect(chatDocuments([reply])).toEqual([]);
	});

	it('does not resolve a note, a chat or a page that carries the same id', () => {
		expect(knowledgeDocument([cited([{ file_id: file, name: 'A note' }])], file, [])).toBeNull();
		expect(
			knowledgeDocument([cited([{ file_id: file, source: 'https://a.example/x', name: 'x' }])], file, [])
		).toBeNull();
	});

	it('opens the chat’s own document when the cited file is one of its uploads or outputs', () => {
		const [own] = messageDocuments(msg({ files: [out(77, 'notes.md')] }));
		expect(knowledgeDocument([reply], file, [own])).toBe(own);
	});

	it('does not throw on hostile sources', () => {
		const hostile = msg({
			sources: [
				null,
				'x',
				{ document: 'not a list', metadata: [] },
				{ document: ['a'], metadata: 'not a list' },
				{ document: ['a', 'b', 'c'], metadata: [null, 'a string', { file_id: file, source: 'notes.md', name: 5 }] }
			]
		} as unknown as Partial<Message>);
		expect(() => knowledgeDocument([hostile, null as unknown as Message], file, [])).not.toThrow();
		expect(knowledgeDocument([hostile], file, [])?.name).toBe('notes.md');
	});

	it('shows an html file as source only: its kind is html, never framed (the views decide that)', () => {
		const html = cited([{ file_id: file, name: 'page.html', source: 'page.html' }]);
		expect(knowledgeDocument([html], file, [])?.kind).toBe('html');
	});
});
