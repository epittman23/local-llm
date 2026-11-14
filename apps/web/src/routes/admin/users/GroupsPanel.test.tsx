import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getGroups } from '@/lib/apis/groups';
import { getUserDefaultPermissions } from '@/lib/apis/users';
import { useAuthStore } from '@/lib/stores/authStore';
import { GroupsPanel } from './GroupsPanel';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
vi.mock('@/lib/apis/groups', () => ({
	createNewGroup: vi.fn(),
	deleteGroupById: vi.fn(),
	getGroups: vi.fn(),
	updateGroupById: vi.fn()
}));
vi.mock('@/lib/apis/users', () => ({
	getUserDefaultPermissions: vi.fn(),
	getUserDefaultPermissionsDefaults: vi.fn(),
	updateUserDefaultPermissions: vi.fn()
}));
vi.mock('./GroupUsers', () => ({ GroupUsers: () => <div>group users panel</div> }));
vi.mock('./GroupPreviewPanel', () => ({ GroupPreviewPanel: () => <div>group preview panel</div> }));

const GROUPS = [
	{
		id: 'g1',
		name: 'Research',
		description: 'Lab folks',
		permissions: { chat: { file_upload: false } },
		member_count: 4
	},
	{ id: 'g2', name: 'Support', description: '', permissions: {}, member_count: 9 }
];

beforeEach(() => {
	vi.clearAllMocks();
	useAuthStore.setState({ token: 'tok' } as never);
	vi.mocked(getGroups).mockResolvedValue(GROUPS as never);
	vi.mocked(getUserDefaultPermissions).mockResolvedValue({} as never);
});

const renderPanel = async (url = '/admin/users/groups') => {
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<MemoryRouter initialEntries={[url]}>
				<TooltipProvider>
					<GroupsPanel />
				</TooltipProvider>
			</MemoryRouter>
		</QueryClientProvider>
	);
	await screen.findByText('Research');
};

describe('GroupsPanel', () => {
	it('lists each group with its member count and permissions summary', async () => {
		await renderPanel();
		expect(screen.getByText('4 members')).toBeTruthy();
		expect(screen.getByText('Custom permissions')).toBeTruthy();
		expect(screen.getByText('Uses defaults')).toBeTruthy();
		expect(screen.getByText('No description')).toBeTruthy();
	});

	it('opens the group editor from a group row', async () => {
		await renderPanel();
		fireEvent.click(screen.getByRole('button', { name: /Research/ }));
		expect(await screen.findByText('Edit User Group', { selector: 'h2' })).toBeTruthy();
	});

	it('opens the group editor on arrival from an id deep link', async () => {
		await renderPanel('/admin/users/groups?id=g2');
		expect(await screen.findByText('Edit User Group', { selector: 'h2' })).toBeTruthy();
	});

	it('opens the add-group modal from New Group', async () => {
		await renderPanel();
		fireEvent.click(screen.getByRole('button', { name: 'New Group' }));
		expect(await screen.findByText('Add User Group', { selector: 'h2' })).toBeTruthy();
	});

	it('opens the default permissions modal from its row', async () => {
		await renderPanel();
		fireEvent.click(screen.getByRole('button', { name: /Default permissions/ }));
		expect(await screen.findByText('Edit Default Permissions', { selector: 'h2' })).toBeTruthy();
	});

	it('filters by the search text and clears it from the clear button', async () => {
		await renderPanel();
		fireEvent.change(screen.getByLabelText('Search Groups'), { target: { value: 'supp' } });
		expect(screen.queryByText('Research')).toBeNull();
		expect(screen.getByText('Support')).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
		expect(screen.getByText('Research')).toBeTruthy();
	});

	it('says so when no group matches the search', async () => {
		await renderPanel();
		fireEvent.change(screen.getByLabelText('Search Groups'), { target: { value: 'zzz' } });
		expect(screen.getByText('No groups found')).toBeTruthy();
	});
});

describe('GroupsPanel when a load fails (STA-4, #981)', () => {
	const renderFailing = () =>
		render(
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<MemoryRouter initialEntries={['/admin/users/groups']}>
					<TooltipProvider>
						<GroupsPanel />
					</TooltipProvider>
				</MemoryRouter>
			</QueryClientProvider>
		);

	it('shows the failure in place of the list, with no toast, and tries both loads again', async () => {
		vi.mocked(getGroups).mockRejectedValue('Database is locked');
		renderFailing();

		expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load groups");
		expect(screen.queryByText('No groups found')).toBeNull();
		expect(toast.error).not.toHaveBeenCalled();

		vi.mocked(getGroups).mockResolvedValue(GROUPS as never);
		fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
		expect(await screen.findByText('Research')).toBeInTheDocument();
		expect(getUserDefaultPermissions).toHaveBeenCalledTimes(2);
	});

	it('does not offer New Group or the defaults when the default permissions did not load', async () => {
		vi.mocked(getUserDefaultPermissions).mockRejectedValue('Database is locked');
		renderFailing();

		expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load groups");
		expect(screen.queryByRole('button', { name: 'New Group' })).toBeNull();
	});
});
