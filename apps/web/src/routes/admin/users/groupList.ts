import type { Group } from './EditGroupModal';

export type GroupSort = 'members' | 'name';

/**
 * The Groups tab's filter + sort: name substring (case-insensitive), then either
 * by name, or -- the default -- by member count descending, ties by name.
 */
export function filterAndSortGroups(groups: Group[], query: string, sortBy: GroupSort): Group[] {
	const q = query.toLowerCase();
	return groups
		.filter((group) => q === '' || group.name.toLowerCase().includes(q))
		.sort((a, b) => {
			if (sortBy === 'name') return a.name.localeCompare(b.name);
			return (b.member_count ?? 0) - (a.member_count ?? 0) || a.name.localeCompare(b.name);
		});
}
