import { describe, expect, it } from 'vitest';
import { buildEmojiIndex, codeToChar, searchEmojis } from './emoji';

describe('emoji index', () => {
	const index = buildEmojiIndex(
		{ '1F44D': ['+1', 'thumbsup'], '263A-FE0F': 'relaxed', '1F600': 'grinning' },
		{ Smileys: ['1F600', '263A-FE0F', 'FFFFF'], People: ['1F44D'] }
	);

	it('turns code points into characters, including sequences', () => {
		expect(codeToChar('1F44D')).toBe('👍');
		expect(codeToChar('263A-FE0F')).toBe('☺️');
	});
	it('resolves every shortcode, and submits the first', () => {
		expect(index.byName.thumbsup).toBe('👍');
		expect(index.byName['+1']).toBe('👍');
		expect(index.all.find((e) => e.char === '👍')?.name).toBe('+1');
	});
	it('keeps group order and skips codes without a shortcode', () => {
		expect(index.all.map((e) => e.name)).toEqual(['grinning', 'relaxed', '+1']);
	});
	it('searches every shortcode', () => {
		expect(searchEmojis(index, 'thumb').map((e) => e.char)).toEqual(['👍']);
		expect(searchEmojis(index, '  ')).toHaveLength(3);
	});
});
