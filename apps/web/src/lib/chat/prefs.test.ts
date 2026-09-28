import { describe, expect, it } from 'vitest';
import { chatPrefs, cssUrl } from './prefs';

describe('chat prefs', () => {
	it('defaults to what the Settings modal shows for an unset value', () => {
		expect(chatPrefs(null)).toMatchObject({
			chatBubble: true,
			showUsername: false,
			widescreen: false,
			direction: 'auto',
			markdownInUserMessages: true,
			markdownInAssistantMessages: true,
			regenerateMenu: true,
			scrollOnResponse: true,
			scrollOnBranch: true,
			titleInTab: true,
			autoPlayback: false,
			temporaryByDefault: false,
			webSearchAlways: false,
			largeTextAsFile: false,
			backgroundImageUrl: null
		});
	});
	it('reads the saved values; null counts as unset', () => {
		const p = chatPrefs({ chatBubble: false, chatDirection: 'RTL', webSearch: 'always', temporaryChatByDefault: true, regenerateMenu: null, backgroundImageUrl: '' });
		expect(p).toMatchObject({ chatBubble: false, direction: 'rtl', webSearchAlways: true, temporaryByDefault: true, regenerateMenu: true, backgroundImageUrl: null });
		expect(chatPrefs({ chatDirection: 'LTR' }).direction).toBe('ltr');
	});
	it('quotes a background URL so it cannot end the CSS declaration', () => {
		expect(cssUrl('data:image/png;base64,AAA=')).toBe('url("data:image/png;base64,AAA=")');
		expect(cssUrl('a"); background: red; ("')).toBe('url("a\\22 ); background: red; (\\22 ")');
	});
});
