// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { initI18n } from './index';

describe('the language detector (#326)', () => {
	it('leaves the stored locale as it was', async () => {
		localStorage.setItem('locale', 'de-DE');

		await initI18n();

		expect(localStorage.getItem('locale')).toBe('de-DE');
	});
});
