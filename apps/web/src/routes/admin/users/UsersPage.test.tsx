import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getGroups } from '@/lib/apis/groups';
import { getUsers } from '@/lib/apis/users';
import { useAuthStore } from '@/lib/stores/authStore';
import { routePaths } from '@/routes/routePaths';
import { useAccountCountKnown, useAdminSingleUser } from '../adminVisibility';
import { UsersPage } from './UsersPage';

vi.mock('../adminVisibility', () => ({ useAdminSingleUser: vi.fn(), useAccountCountKnown: vi.fn() }));
vi.mock('@/lib/apis/groups', () => ({ getGroups: vi.fn() }));
vi.mock('@/lib/apis/users', () => ({ getUsers: vi.fn() }));
vi.mock('./UserList', () => ({ UserList: () => <div>user list</div> }));
vi.mock('./GroupsPanel', () => ({ GroupsPanel: () => <div>groups panel</div> }));

beforeEach(() => {
	vi.clearAllMocks();
	useAuthStore.setState({ token: 'tok' } as never);
	vi.mocked(getUsers).mockResolvedValue({ users: [], total: 2 } as never);
	vi.mocked(getGroups).mockResolvedValue([] as never);
});

const renderAt = (path: string) =>
	render(
		<MemoryRouter initialEntries={[path]}>
			<Routes>
				<Route path="/admin/users/*" element={<UsersPage />} />
			</Routes>
		</MemoryRouter>
	);

/** Where the router is now. */
function Where() {
	return <p>at {useLocation().pathname}</p>;
}

describe('UsersPage (S5-D2, #1022)', () => {
	it('shows Overview and Groups with more than one account', async () => {
		vi.mocked(useAdminSingleUser).mockReturnValue(false);
		renderAt(routePaths.adminUsersGroups);
		expect(screen.getByRole('navigation', { name: 'Users sections' })).toBeTruthy();
		expect(screen.getByRole('link', { name: /Overview/ })).toBeTruthy();
		expect(screen.getByRole('link', { name: /Groups/ })).toBeTruthy();
		expect(await screen.findByText('groups panel')).toBeTruthy();
	});

	it('hides Groups, and its Default permissions, while there is one account', () => {
		vi.mocked(useAdminSingleUser).mockReturnValue(true);
		renderAt(routePaths.adminUsersOverview);
		expect(screen.getByText('user list')).toBeTruthy();
		expect(screen.queryByRole('link', { name: /Groups/ })).toBeNull();
	});

	it('sends the Groups address to /admin/users once one account is known (S5-D2)', async () => {
		vi.mocked(useAdminSingleUser).mockReturnValue(true);
		vi.mocked(useAccountCountKnown).mockReturnValue(true);
		render(
			<MemoryRouter initialEntries={[routePaths.adminUsersGroups]}>
				<Routes>
					<Route
						path="/admin/users/*"
						element={
							<>
								<UsersPage />
								<Where />
							</>
						}
					/>
				</Routes>
			</MemoryRouter>
		);
		expect(await screen.findByText(`at ${routePaths.adminUsers}`)).toBeTruthy();
		expect(screen.getByText('user list')).toBeTruthy();
	});

	it('keeps the Groups address with the user list until the count is known, and Groups once a second appears', async () => {
		vi.mocked(useAdminSingleUser).mockReturnValue(true);
		vi.mocked(useAccountCountKnown).mockReturnValue(false);
		const { rerender } = renderAt(routePaths.adminUsersGroups);
		expect(screen.getByText('user list')).toBeTruthy();
		expect(screen.queryByText('groups panel')).toBeNull();
		vi.mocked(useAdminSingleUser).mockReturnValue(false);
		rerender(
			<MemoryRouter initialEntries={[routePaths.adminUsersGroups]}>
				<Routes>
					<Route path="/admin/users/*" element={<UsersPage />} />
				</Routes>
			</MemoryRouter>
		);
		expect(await screen.findByText('groups panel')).toBeTruthy();
	});
});
