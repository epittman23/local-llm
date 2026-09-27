// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { speechParts } from './useReadAloud';

describe('speechParts', () => {
	it('speaks sentences without markup, code or reasoning', () => {
		const text = '<details type="reasoning">\n<summary>t</summary>\nhmm\n</details>\n**Hello** there. See [the docs](https://x). ```js\ncode()\n```\nBye!';
		expect(speechParts(text)).toEqual(['Hello there.', 'See the docs.', 'Bye!']);
	});
	it('can split by paragraph', () => {
		expect(speechParts('One. Two.\n\nThree.', 'paragraphs')).toEqual(['One. Two.', 'Three.']);
	});
});
