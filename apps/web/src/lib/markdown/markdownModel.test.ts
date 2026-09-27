// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { processDetails, removeAllDetails, replaceTokens } from './content';
import { lexMessage } from './lexer';
import { alertOf, detailTitle, groupDetails, htmlKind, inAppPath, sourceLabel, tableToCsv } from './markdownModel';

describe('chat lexer', () => {
	it('recognises math, citations, mentions, details and colon fences', () => {
		const types = lexMessage('Area is $\\pi r^2$ [1] <@U:u1|Ann>\n\n<details type="reasoning" done="true" duration="3">\n<summary>Thinking</summary>\nhmm\n</details>\n\n:::writing\nhello\n:::\n').map((t) => t.type);
		expect(types).toEqual(['paragraph', 'space', 'details', 'space', 'colonFence']);
		const inline = lexMessage('Area is $\\pi r^2$ [1] <@U:u1|Ann>')[0].tokens.map((t: any) => t.type);
		expect(inline).toEqual(expect.arrayContaining(['inlineKatex', 'citation', 'mention']));
	});
	it('does not change the global marked used elsewhere', async () => {
		const { marked } = await import('marked');
		expect((marked.lexer('$x$')[0] as any).tokens?.some((t: any) => t.type === 'inlineKatex')).toBe(false);
	});
	it('fills placeholders outside code only', () => {
		expect(replaceTokens('Hi {{user}} `{{user}}`', 'Bot', 'Ann')).toBe('Hi Ann `{{user}}`');
	});
});

describe('details', () => {
	it('groups consecutive reasoning and tool blocks', () => {
		const tokens = lexMessage('<details type="reasoning">\n<summary>a</summary>\nx\n</details>\n<details type="tool_calls" name="t">\n<summary>b</summary>\ny\n</details>\n\ntext');
		const shown = groupDetails(tokens.filter((t) => t.type !== 'space'));
		expect(shown[0].type).toBe('detail_group');
		expect((shown[0] as any).items).toHaveLength(2);
	});
	it('titles reasoning by duration and state', () => {
		expect(detailTitle({ type: 'reasoning', done: 'true', duration: '0' }, '', false)).toBe('Thought for less than a second');
		expect(detailTitle({ type: 'reasoning', done: 'true', duration: '12' }, '', false)).toBe('Thought for 12 seconds');
		expect(detailTitle({ type: 'reasoning', duration: '120' }, '', true)).toBe('Thought for 2 minutes');
		expect(detailTitle({ type: 'reasoning' }, '', false)).toBe('Thinking...');
		expect(detailTitle({ type: 'code_interpreter' }, '', true)).toBe('Analyzed');
		expect(detailTitle({}, 'Custom', true)).toBe('Custom');
	});
	it('strips or resolves details for copying and resending', () => {
		const c = 'A<details type="reasoning">\n<summary>s</summary>\nx\n</details>B<details type="tool_calls" result="&quot;42&quot;">\n<summary>t</summary>\n</details>';
		expect(removeAllDetails(c)).toBe('AB');
		expect(processDetails(c)).toBe('AB"42"');
	});
});

describe('blocks', () => {
	it('reads GitHub alerts', () => {
		const quote = lexMessage('> [!WARNING]\n> careful')[0];
		expect(alertOf(quote)?.type).toBe('WARNING');
		expect(alertOf(lexMessage('> plain')[0])).toBeNull();
	});
	it('exports tables as CSV with formulas neutralised', () => {
		const table = lexMessage('| a | b |\n|---|---|\n| 1 | =SUM(A1) |')[0];
		expect(tableToCsv(table)).toBe("a,b\n1,'=SUM(A1)");
	});
});

describe('html and links', () => {
	it('recognises only the embeddable shapes', () => {
		expect(htmlKind('<video src="x">https://v/a.mp4?a=1&amp;b=2</video>')).toEqual({ kind: 'video', src: 'https://v/a.mp4?a=1&b=2' });
		expect(htmlKind('<iframe src="https://www.youtube.com/embed/abcdefghijk"></iframe>')).toEqual({ kind: 'youtube', id: 'abcdefghijk' });
		expect(htmlKind('<status title="Searching" done="false" />')).toEqual({ kind: 'status', title: 'Searching', done: false });
		expect(htmlKind('<file type="html" id="f1" />')).toEqual({ kind: 'htmlFile', fileId: 'f1' });
		expect(htmlKind('<script>alert(1)</script>')).toEqual({ kind: 'text', text: '<script>alert(1)</script>' });
	});
	it('labels sources and spots in-app links', () => {
		expect(sourceLabel('https://www.example.com/a/b')).toBe('example.com');
		expect(sourceLabel('a'.repeat(40))).toBe(`${'a'.repeat(15)}...${'a'.repeat(10)}`);
		expect(inAppPath('/c/123', 'http://x')).toBe('/c/123');
		expect(inAppPath('https://other/c/1', 'http://x')).toBeNull();
	});
});
