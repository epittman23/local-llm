import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import saveAs from 'file-saver';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAllUserChats } from '@/lib/apis/chats';
import { exportConfig } from '@/lib/apis/configs';
import { getAllUsers } from '@/lib/apis/users';
import { downloadDatabase } from '@/lib/apis/utils';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import Database from './Database';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
vi.mock('file-saver', () => ({ default: vi.fn() }));
vi.mock('@/lib/apis/chats', () => ({ getAllUserChats: vi.fn() }));
vi.mock('@/lib/apis/configs', () => ({ exportConfig: vi.fn(), importConfig: vi.fn() }));
vi.mock('@/lib/apis/users', () => ({ getAllUsers: vi.fn() }));
vi.mock('@/lib/apis/utils', () => ({ downloadDatabase: vi.fn() }));

beforeEach(() => {
	vi.clearAllMocks();
	useAuthStore.setState({ token: 'tok' } as never);
	useConfigStore.setState({ config: { features: { enable_admin_export: true } } } as never);
});

describe('Database settings', () => {
	it('opens the file picker from the Import button', () => {
		render(<Database />);
		const input = screen.getByLabelText('Config JSON file') as HTMLInputElement;
		const click = vi.spyOn(input, 'click');
		fireEvent.click(screen.getByRole('button', { name: 'Import' }));
		expect(click).toHaveBeenCalledTimes(1);
	});

	it('downloads the exported config as a JSON file', async () => {
		vi.mocked(exportConfig).mockResolvedValue({ a: 1 });
		render(<Database />);
		fireEvent.click(screen.getAllByRole('button', { name: 'Export' })[0]);
		await waitFor(() => expect(saveAs).toHaveBeenCalledTimes(1));
		expect(exportConfig).toHaveBeenCalledWith('tok');
		expect(vi.mocked(saveAs).mock.calls[0][1]).toMatch(/^config-\d+\.json$/);
	});

	it('downloads the database from the Database button', () => {
		vi.mocked(downloadDatabase).mockResolvedValue(undefined as never);
		render(<Database />);
		fireEvent.click(screen.getByRole('button', { name: 'Database' }));
		expect(downloadDatabase).toHaveBeenCalledWith('tok');
	});

	it('saves every chat as a JSON export', async () => {
		vi.mocked(getAllUserChats).mockResolvedValue([] as never);
		render(<Database />);
		fireEvent.click(screen.getAllByRole('button', { name: 'Export' })[1]);
		await waitFor(() => expect(saveAs).toHaveBeenCalledTimes(1));
		expect(vi.mocked(saveAs).mock.calls[0][1]).toMatch(/^all-chats-export-\d+\.json$/);
	});

	it('saves the users as users.csv', async () => {
		vi.mocked(getAllUsers).mockResolvedValue({
			users: [{ id: '1', name: 'Ada', email: 'a@x.io', role: 'admin' }]
		} as never);
		render(<Database />);
		fireEvent.click(screen.getAllByRole('button', { name: 'Export' })[2]);
		await waitFor(() => expect(saveAs).toHaveBeenCalledTimes(1));
		expect(vi.mocked(saveAs).mock.calls[0][1]).toBe('users.csv');
	});

	it('hides the database exports when the backend turns them off', () => {
		useConfigStore.setState({ config: { features: { enable_admin_export: false } } } as never);
		render(<Database />);
		expect(screen.queryByRole('button', { name: 'Database' })).toBeNull();
		expect(screen.getAllByRole('button', { name: 'Export' })).toHaveLength(1);
	});
});
