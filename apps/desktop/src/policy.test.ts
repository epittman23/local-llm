import { describe, expect, it } from 'vitest';
import { classifyOpen, isAllowedFrameNavigation, isAllowedPermission, isAppUrl } from './policy';

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
		expect(isAllowedPermission('media', app, app, ['audio'])).toBe(true);
		expect(isAllowedPermission('clipboard-sanitized-write', app, app)).toBe(true);
		expect(isAllowedPermission('notifications', 'https://evil.example', app)).toBe(false);
	});

	it('grants media for audio only, never the camera', () => {
		expect(isAllowedPermission('media', app, app, ['audio'])).toBe(true);
		expect(isAllowedPermission('media', app, app, ['video'])).toBe(false);
		expect(isAllowedPermission('media', app, app, ['audio', 'video'])).toBe(false);
		expect(isAllowedPermission('media', app, app, ['unknown'])).toBe(false);
		expect(isAllowedPermission('media', app, app)).toBe(false);
		expect(isAllowedPermission('media', app, app, [])).toBe(false);
	});

	it('refuses media to other origins even for audio', () => {
		expect(isAllowedPermission('media', 'https://evil.example', app, ['audio'])).toBe(false);
	});

	it('refuses the rest even to the app', () => {
		expect(isAllowedPermission('geolocation', app, app)).toBe(false);
		expect(isAllowedPermission('openExternal', app, app)).toBe(false);
		expect(isAllowedPermission('hid', app, app)).toBe(false);
	});
});

describe('isAllowedFrameNavigation', () => {
	const sandboxed = 'null';

	it('keeps a sandbox output’s frame from navigating itself anywhere but another inline document', () => {
		for (const url of [
			'https://example.com/?leak=1',
			'http://127.0.0.1:4000/c/x',
			'data:text/html,x',
			'javascript:1'
		]) {
			expect(isAllowedFrameNavigation('about:srcdoc', url, sandboxed, app)).toBe(false);
			expect(isAllowedFrameNavigation('about:blank', url, sandboxed, app)).toBe(false);
			expect(isAllowedFrameNavigation('', url, null, app)).toBe(false);
		}
		expect(isAllowedFrameNavigation('about:srcdoc', 'about:blank', sandboxed, app)).toBe(true);
		expect(isAllowedFrameNavigation('about:srcdoc', 'about:srcdoc', sandboxed, app)).toBe(true);
		expect(isAllowedFrameNavigation('about:blank#x', 'about:blank?y', sandboxed, app)).toBe(true);
		// No initiator (none, or one already gone) is not the app.
		expect(isAllowedFrameNavigation('about:srcdoc', 'https://example.com/', null, app)).toBe(false);
		// Any spelling of the inline URLs counts as inline.
		expect(isAllowedFrameNavigation('ABOUT:SRCDOC', 'https://example.com/', sandboxed, app)).toBe(false);
		expect(isAllowedFrameNavigation('about:srcdoc?x', 'https://example.com/', sandboxed, app)).toBe(false);
		expect(isAllowedFrameNavigation('about:srcdoc', 'ABOUT:BLANK', sandboxed, app)).toBe(true);
	});

	it('lets the app’s own page load an iframe’s src', () => {
		expect(isAllowedFrameNavigation('about:blank', 'https://www.youtube.com/embed/x', app, app)).toBe(true);
		expect(isAllowedFrameNavigation('', 'http://127.0.0.1:4000/api/v1/files/x/content/html', app, app)).toBe(true);
		expect(isAllowedFrameNavigation('about:srcdoc', 'https://example.com/', 'https://example.com', app)).toBe(false);
		// The app's page may navigate even a srcdoc frame (it sets the frames it makes); no sandboxed frame is the app.
		expect(isAllowedFrameNavigation('about:srcdoc', 'https://example.com/', app, app)).toBe(true);
	});

	it('leaves frames showing a page of their own to the other rules', () => {
		expect(
			isAllowedFrameNavigation('https://www.youtube.com/embed/x', 'https://www.youtube.com/watch', null, app)
		).toBe(true);
	});
});
