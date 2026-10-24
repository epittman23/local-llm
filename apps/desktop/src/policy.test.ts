import { describe, expect, it } from 'vitest';
import { classifyOpen, isAllowedPermission, isAppUrl } from './policy';

const app = 'http://127.0.0.1:4000';

describe('classifyOpen', () => {
	it('keeps the server’s own pages in the app', () => {
		expect(classifyOpen('http://127.0.0.1:4000/c/abc', app)).toBe('in-app');
		expect(classifyOpen('http://127.0.0.1:4000/api/v1/files/x/content', app)).toBe('in-app');
	});

	it('sends other sites to the system browser', () => {
		expect(classifyOpen('https://openrouter.ai/keys', app)).toBe('external');
		expect(classifyOpen('http://localhost:4000/', app)).toBe('external');
		expect(classifyOpen('http://127.0.0.1:8090/', app)).toBe('external');
		expect(classifyOpen('mailto:someone@example.com', app)).toBe('external');
	});

	it('refuses everything else', () => {
		expect(classifyOpen('file:///etc/passwd', app)).toBe('deny');
		expect(classifyOpen('javascript:alert(1)', app)).toBe('deny');
		expect(classifyOpen('about:blank', app)).toBe('deny');
		expect(classifyOpen('not a url', app)).toBe('deny');
	});

	it('treats nothing as the app before the app window has an origin', () => {
		expect(classifyOpen('http://127.0.0.1:4000/', '')).toBe('external');
		expect(isAppUrl('http://127.0.0.1:4000/', '')).toBe(false);
	});
});

describe('isAllowedPermission', () => {
	it('grants the app’s few permissions to its own origin only', () => {
		expect(isAllowedPermission('notifications', 'http://127.0.0.1:4000/c/1', app)).toBe(true);
		expect(isAllowedPermission('media', app, app)).toBe(true);
		expect(isAllowedPermission('clipboard-sanitized-write', app, app)).toBe(true);
		expect(isAllowedPermission('notifications', 'https://evil.example', app)).toBe(false);
	});

	it('refuses the rest even to the app', () => {
		expect(isAllowedPermission('geolocation', app, app)).toBe(false);
		expect(isAllowedPermission('openExternal', app, app)).toBe(false);
		expect(isAllowedPermission('hid', app, app)).toBe(false);
	});
});
