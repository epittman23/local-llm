import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import saveAs from 'file-saver';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAllUserChats } from '@/lib/apis/chats';
import { exportConfig } from '@/lib/apis/configs';
import { getAllUsers } from '@/lib/apis/users';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { copyToClipboard } from '@/lib/utils';
import Database, { BACKUP_COMMAND, exportName } from './Database';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
vi.mock('file-saver', () => ({ default: vi.fn() }));
vi.mock('@/lib/apis/chats', () => ({ getAllUserChats: vi.fn() }));
vi.mock('@/lib/apis/configs', () => ({ exportConfig: vi.fn(), importConfig: vi.fn() }));
vi.mock('@/lib/apis/users', () => ({ getAllUsers: vi.fn() }));
vi.mock('@/lib/utils', async (orig) => ({ ...(await orig<object>()), copyToClipboard: vi.fn(async () => true) }));

beforeEach(() => {
	vi.clearAllMocks();
	useAuthStore.setState({ token: 'tok' } as never);
	useConfigStore.setState({ config: { features: { enable_admin_export: true } } } as never);
});

describe('Database settings', () => {
	it('opens the file picker from the Import button', () => {
		render(<Database />);
		const input = screen.getByLabelText('Settings JSON file') as HTMLInputElement;
		const click = vi.spyOn(input, 'click');
		fireEvent.click(screen.getByRole('button', { name: 'Import settings' }));
		expect(click).toHaveBeenCalledTimes(1);
	});

	it('downloads the exported config as a JSON file', async () => {
		vi.mocked(exportConfig).mockResolvedValue({ a: 1 });
		render(<Database />);
		fireEvent.click(screen.getByRole('button', { name: 'Export settings' }));
		await waitFor(() => expect(saveAs).toHaveBeenCalledTimes(1));
		expect(exportConfig).toHaveBeenCalledWith('tok');
		expect(vi.mocked(saveAs).mock.calls[0][1]).toMatch(/^local-llm-config-\d{4}-\d{2}-\d{2}\.json$/);
	});

	it('has no database download; it shows the pg_dump backup command and copies it (#961)', async () => {
		render(<Database />);
		expect(screen.queryByRole('button', { name: 'Database' })).toBeNull();
		expect(screen.getByText(BACKUP_COMMAND)).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Copy the pg_dump command' }));
		await waitFor(() => expect(copyToClipboard).toHaveBeenCalledWith(BACKUP_COMMAND));
		expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
	});

	it('names a download after the app, what it holds and the day', () => {
		expect(exportName('users', 'csv', new Date('2026-11-15T12:00:00Z'))).toBe('local-llm-users-2026-11-15.csv');
	});

	it('saves every chat as a JSON export', async () => {
		vi.mocked(getAllUserChats).mockResolvedValue([] as never);
		render(<Database />);
		fireEvent.click(screen.getByRole('button', { name: 'Export all chats' }));
		await waitFor(() => expect(saveAs).toHaveBeenCalledTimes(1));
		expect(vi.mocked(saveAs).mock.calls[0][1]).toMatch(/^local-llm-chats-[\d-]+\.json$/);
	});

	it('saves the users as a CSV', async () => {
		vi.mocked(getAllUsers).mockResolvedValue({
			users: [{ id: '1', name: 'Ada', email: 'a@x.io', role: 'admin' }]
		} as never);
		render(<Database />);
		fireEvent.click(screen.getByRole('button', { name: 'Export users' }));
		await waitFor(() => expect(saveAs).toHaveBeenCalledTimes(1));
		expect(vi.mocked(saveAs).mock.calls[0][1]).toMatch(/^local-llm-users-[\d-]+\.csv$/);
	});

	it('hides the database exports when the backend turns them off', () => {
		useConfigStore.setState({ config: { features: { enable_admin_export: false } } } as never);
		render(<Database />);
		expect(screen.queryByRole('button', { name: 'Export all chats' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Export users' })).toBeNull();
		expect(screen.getByRole('button', { name: 'Export settings' })).toBeTruthy();
	});
});
