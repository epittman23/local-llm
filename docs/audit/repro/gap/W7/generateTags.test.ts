import { afterEach, expect, it, vi } from 'vitest';
import { generateTags } from '@/lib/apis/index.ts';

const reply = (content: string) =>
	vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 }));

afterEach(() => vi.unstubAllGlobals());

it('keeps tags without apostrophes', async () => {
	vi.stubGlobal('fetch', reply('{"tags": ["Statistics", "R"]}'));
	expect(await generateTags('t', 'm', '[]')).toEqual(['Statistics', 'R']);
});

it('drops every tag when one contains an apostrophe', async () => {
	vi.stubGlobal('fetch', reply('{"tags": ["Student\'s t-test", "Statistics"]}'));
	const tags = await generateTags('t', 'm', '[]');
	console.log('tags returned:', JSON.stringify(tags));
	expect(tags).toEqual([]);
});
