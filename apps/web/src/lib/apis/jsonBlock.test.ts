import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateTags, generateTitle } from './index';
import { parseJsonBlock } from './jsonBlock';

describe('parseJsonBlock (#306)', () => {
	it('keeps an apostrophe inside a value', () => {
		expect(parseJsonBlock('{"tags": ["Student\'s t-test", "Statistics"]}')).toEqual({
			tags: ["Student's t-test", 'Statistics']
		});
		expect(parseJsonBlock('{"title": "📊 Student’s t-test explained"}')).toEqual({
			title: '📊 Student’s t-test explained'
		});
	});

	it('still reads a reply written with single quotes', () => {
		expect(parseJsonBlock("{'tags': ['Math', 'Algebra']}")).toEqual({ tags: ['Math', 'Algebra'] });
	});

	it('finds the block inside surrounding text', () => {
		expect(parseJsonBlock('Here you go:\n```json\n{"tags": ["Coding"]}\n```')).toEqual({ tags: ['Coding'] });
	});

	it('is null for a reply with no object, or one that does not parse either way', () => {
		expect(parseJsonBlock('no json here')).toBeNull();
		expect(parseJsonBlock('{"tags": [}')).toBeNull();
		expect(parseJsonBlock('["a", "b"]')).toBeNull();
		expect(parseJsonBlock('} before {')).toBeNull();
	});
});

describe('title and tag generation read the reply with it (#306)', () => {
	const reply = (content: string) =>
		vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 }));

	afterEach(() => vi.unstubAllGlobals());

	it('keeps every tag when one has an apostrophe', async () => {
		vi.stubGlobal('fetch', reply('{"tags": ["Student\'s t-test", "Statistics"]}'));
		expect(await generateTags('t', 'm', 'messages')).toEqual(["Student's t-test", 'Statistics']);
	});

	it('gives no tags for a reply without a list', async () => {
		vi.stubGlobal('fetch', reply('{"tags": "Statistics"}'));
		expect(await generateTags('t', 'm', 'messages')).toEqual([]);
	});

	it('keeps a title with an apostrophe, and gives none for a reply without one', async () => {
		vi.stubGlobal('fetch', reply('{"title": "Student\'s t-test"}'));
		expect(await generateTitle('t', 'm', [])).toBe("Student's t-test");
		vi.stubGlobal('fetch', reply('no title'));
		expect(await generateTitle('t', 'm', [])).toBeNull();
	});
});
