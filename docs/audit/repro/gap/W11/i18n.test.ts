import { describe, expect, it } from 'vitest';
import i18next, { initI18n } from '@/lib/i18n/index';
import { promptVariables } from '@/lib/chat/request';

describe('W11 i18n', () => {
	it('locale detection with a non-en-US browser', async () => {
		Object.defineProperty(window.navigator, 'language', { value: 'de-DE', configurable: true });
		Object.defineProperty(window.navigator, 'languages', { value: ['de-DE', 'de'], configurable: true });
		localStorage.removeItem('locale');
		await initI18n();
		console.log('navigator', navigator.languages, 'i18next.language', i18next.language, 'resolved', i18next.resolvedLanguage);
		console.log('localStorage.locale', localStorage.getItem('locale'));
		console.log('USER_LANGUAGE', promptVariables(null)['{{USER_LANGUAGE}}']);
		console.log('missing-key t():', i18next.t('Hello {{name}}', { name: 'Ann' }));
	});
});
