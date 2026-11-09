import { describe, expect, it } from 'vitest';
import { implementedTabIds, tabLoaders } from './adminTabComponents';
import { adminTabs, personalTabs } from './settingsTabs';

describe('tabLoaders', () => {
	it('derives implementedTabIds from the loaders', () => {
		expect([...implementedTabIds].sort()).toEqual(Object.keys(tabLoaders).sort());
	});

	it('has a loader for every listed tab id it implements, and no unknown ids', () => {
		const known = new Set([...adminTabs, ...personalTabs].map((t) => t.id));
		for (const id of implementedTabIds) expect(known.has(id), id).toBe(true);
	});

	it('resolves every loader to a module with a default React component', async () => {
		for (const [id, load] of Object.entries(tabLoaders)) {
			const mod = await load();
			expect(['function', 'object'], id).toContain(typeof mod.default);
			expect(mod.default, id).toBeTruthy();
		}
	}, 60_000);
});
