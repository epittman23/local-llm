import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toastFailure } from '@/components/common/failureToast';
import { TooltipProvider } from '@/components/ui/tooltip';
import { createNewGroup, getGroups } from '@/lib/apis/groups';
import { getUserDefaultPermissions, updateUserDefaultPermissions } from '@/lib/apis/users';
import { useAuthStore } from '@/lib/stores/authStore';
import { GroupsPanel } from './GroupsPanel';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
vi.mock('@/components/common/failureToast', () => ({ toastFailure: vi.fn() }));
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
		expect(screen.getByText('9 members')).toBeTruthy();
		expect(screen.getByText(/Lab folks · Custom permissions/)).toBeTruthy();
		expect(screen.getByText(/No description · Uses the defaults/)).toBeTruthy();
	});

	it('keeps New group level with the search when Sort wraps under it on a phone (LAY-4)', async () => {
		await renderPanel();
		const toolbar = screen.getByRole('button', { name: 'New group' }).parentElement as HTMLElement;
		expect(toolbar).toContainElement(screen.getByRole('textbox', { name: 'Search groups' }));
		expect(toolbar).toHaveClass('items-start');
	});

	it('opens the group editor from a group row', async () => {
		await renderPanel();
		fireEvent.click(screen.getByRole('button', { name: /Research/ }));
		expect(await screen.findByRole('heading', { name: 'Edit group' })).toBeTruthy();
	});

	it('opens the group editor on arrival from an id deep link', async () => {
		await renderPanel('/admin/users/groups?id=g2');
		expect(await screen.findByRole('heading', { name: 'Edit group' })).toBeTruthy();
	});

	it('opens the add-group modal from New Group', async () => {
		await renderPanel();
		fireEvent.click(screen.getByRole('button', { name: 'New group' }));
		expect(await screen.findByRole('heading', { name: 'New group' })).toBeTruthy();
	});

	it('opens the default permissions modal from its row', async () => {
		await renderPanel();
		fireEvent.click(screen.getByRole('button', { name: /Default permissions/ }));
		expect(await screen.findByRole('heading', { name: 'Default permissions' })).toBeTruthy();
	});

	it('filters by the search text and clears it from the clear button', async () => {
		await renderPanel();
		fireEvent.change(screen.getByLabelText('Search groups'), { target: { value: 'supp' } });
		expect(screen.queryByText('Research')).toBeNull();
		expect(screen.getByText('Support')).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
		expect(screen.getByText('Research')).toBeTruthy();
	});

	it('says so when no group matches the search', async () => {
		await renderPanel();
		fireEvent.change(screen.getByLabelText('Search groups'), { target: { value: 'zzz' } });
		expect(screen.getByText('Nothing matches “zzz”')).toBeTruthy();
	});

	it('names the Sort menu by its text and sorts by name from it (#987)', async () => {
		await renderPanel();
		const sort = screen.getByRole('button', { name: 'Sort: Members' });
		fireEvent.pointerDown(sort, { button: 0, pointerType: 'mouse' });
		fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Name' }));
		expect(screen.getByRole('button', { name: 'Sort: Name' })).toBeTruthy();
		const names = screen.getAllByRole('listitem').map((li) => li.textContent);
		expect(names[0]).toMatch(/^Research/);
	});

	it('creates a group from New group and says so', async () => {
		vi.mocked(createNewGroup).mockResolvedValue({ id: 'g3' } as never);
		await renderPanel();
		fireEvent.click(screen.getByRole('button', { name: 'New group' }));
		fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Analysts' } });
		fireEvent.click(screen.getByRole('button', { name: 'Create group' }));
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Created “Analysts”'));
	});

	it('reports a failed create through the failure toast', async () => {
		vi.mocked(createNewGroup).mockRejectedValue('Name taken');
		await renderPanel();
		fireEvent.click(screen.getByRole('button', { name: 'New group' }));
		fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Analysts' } });
		fireEvent.click(screen.getByRole('button', { name: 'Create group' }));
		await waitFor(() => expect(toastFailure).toHaveBeenCalledWith("Couldn't create the group.", 'Name taken'));
	});

	it('saves the default permissions from their dialog', async () => {
		vi.mocked(updateUserDefaultPermissions).mockResolvedValue({} as never);
		await renderPanel();
		fireEvent.click(screen.getByRole('button', { name: /Default permissions/ }));
		fireEvent.click(await screen.findByRole('button', { name: 'Save permissions' }));
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Default permissions saved'));
	});

	it('reports a failed save of the default permissions', async () => {
		vi.mocked(updateUserDefaultPermissions).mockRejectedValue('nope');
		await renderPanel();
		fireEvent.click(screen.getByRole('button', { name: /Default permissions/ }));
		fireEvent.click(await screen.findByRole('button', { name: 'Save permissions' }));
		await waitFor(() => expect(toastFailure).toHaveBeenCalledWith("Couldn't save the default permissions.", 'nope'));
	});

	it('explains groups when there are none yet', async () => {
		vi.mocked(getGroups).mockResolvedValue([] as never);
		render(
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<MemoryRouter initialEntries={['/admin/users/groups']}>
					<TooltipProvider>
						<GroupsPanel />
					</TooltipProvider>
				</MemoryRouter>
			</QueryClientProvider>
		);
		expect(await screen.findByText('No groups yet')).toBeTruthy();
		expect(screen.getByText('Groups give their members permissions beyond the defaults.')).toBeTruthy();
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
		expect(screen.queryByText('No groups yet')).toBeNull();
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
		expect(screen.queryByRole('button', { name: 'New group' })).toBeNull();
	});

	it('shows an offline load as a failure, not a spinner that never ends', async () => {
		onlineManager.setOnline(false);
		try {
			renderFailing();
			expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load groups");
			expect(screen.queryByRole('status', { name: 'Loading' })).toBeNull();
		} finally {
			onlineManager.setOnline(true);
		}
	});
});
