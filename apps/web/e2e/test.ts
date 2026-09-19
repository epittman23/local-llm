import { test as base } from '@playwright/test';
import { blockSocketProxy } from './no-socket-proxy';

export { expect } from '@playwright/test';

// Every spec imports `test` from here rather than from @playwright/test, so
// the socket block below applies to all of them without each beforeEach having
// to remember it. See no-socket-proxy.ts for why it matters.
export const test = base.extend<{ socketProxyBlocked: void }>({
	socketProxyBlocked: [
		async ({ page }, use) => {
			await blockSocketProxy(page);
			await use();
		},
		{ auto: true }
	]
});
