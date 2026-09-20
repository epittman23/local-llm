import { describe, expect, it } from 'vitest';
import type { Group } from './EditGroupModal';
import { filterAndSortGroups } from './groupList';

const g = (name: string, member_count?: number): Group => ({ id: name, name, description: '', member_count });
const groups = [g('beta', 2), g('Alpha', 2), g('gamma', 9), g('delta')];

describe('filterAndSortGroups', () => {
	it('sorts by member count descending, then name, with missing counts last', () => {
		expect(filterAndSortGroups(groups, '', 'members').map((x) => x.name)).toEqual(['gamma', 'Alpha', 'beta', 'delta']);
	});
	it('sorts by name when asked', () => {
		expect(filterAndSortGroups(groups, '', 'name').map((x) => x.name)).toEqual(['Alpha', 'beta', 'delta', 'gamma']);
	});
	it('filters case-insensitively on the name', () => {
		expect(filterAndSortGroups(groups, 'ALP', 'members').map((x) => x.name)).toEqual(['Alpha']);
	});
	it('does not reorder the caller\'s array', () => {
		const copy = [...groups];
		filterAndSortGroups(groups, '', 'name');
		expect(groups).toEqual(copy);
	});
});
