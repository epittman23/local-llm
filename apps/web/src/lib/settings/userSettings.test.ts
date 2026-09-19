import { describe, expect, it } from 'vitest';
import { resolvePinnedModels } from './userSettings';

describe('resolvePinnedModels', () => {
	it('follows the admin default until the user has a list of their own', () => {
		expect(resolvePinnedModels({}, 'a,b,,c')).toEqual(['a', 'b', 'c']);
		expect(resolvePinnedModels(null, null)).toEqual([]);
	});
	it("uses the user's own list once set -- even an empty one, which means 'pin nothing'", () => {
		expect(resolvePinnedModels({ pinnedModels: ['x'] }, 'a,b')).toEqual(['x']);
		expect(resolvePinnedModels({ pinnedModels: [] }, 'a,b')).toEqual([]);
	});
});
