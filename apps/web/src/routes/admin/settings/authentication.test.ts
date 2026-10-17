import { describe, expect, it } from 'vitest';
import { isOAuthEditable } from './authentication';

describe('isOAuthEditable', () => {
	it('is editable unless persistent config is explicitly off', () => {
		expect(isOAuthEditable({ ENABLE_OAUTH_PERSISTENT_CONFIG: true })).toBe(true);
		expect(isOAuthEditable({})).toBe(true);
		expect(isOAuthEditable(null)).toBe(true);
		expect(isOAuthEditable({ ENABLE_OAUTH_PERSISTENT_CONFIG: false })).toBe(false);
	});
});
