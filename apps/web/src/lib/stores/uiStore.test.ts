import { afterEach, describe, expect, it, vi } from 'vitest';

/** The store reads localStorage once, when its module loads. */
async function freshStore() {
	vi.resetModules();
	return (await import('./uiStore')).useUIStore;
}

afterEach(() => {
	vi.unstubAllGlobals();
	localStorage.removeItem('sidebar');
});

describe('the sidebar state (#930)', () => {
	it('starts open in a browser that has never changed it', async () => {
		localStorage.removeItem('sidebar');
		expect((await freshStore()).getState().sidebarOpen).toBe(true);
	});

	it('remembers a closed sidebar, and an open one', async () => {
		localStorage.sidebar = 'false';
		const store = await freshStore();
		expect(store.getState().sidebarOpen).toBe(false);
		store.getState().toggleSidebar();
		expect(localStorage.sidebar).toBe('true');
		expect((await freshStore()).getState().sidebarOpen).toBe(true);
	});

	it('starts open when storage cannot be read', async () => {
		const blocked = new Proxy(
			{},
			{
				get() {
					throw new Error('blocked');
				}
			}
		);
		vi.stubGlobal('localStorage', blocked);
		const store = await freshStore();
		vi.unstubAllGlobals();
		expect(store.getState().sidebarOpen).toBe(true);
	});
});
