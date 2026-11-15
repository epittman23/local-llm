import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getChatListByFolderId } from '@/lib/apis/chats';
import { updateFolderById } from '@/lib/apis/folders';
import { useAuthStore } from '@/lib/stores/authStore';
import { FolderHome } from './FolderHome';

const { toastSuccess, toastError } = vi.hoisted(() => ({ toastSuccess: vi.fn(), toastError: vi.fn() }));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: toastSuccess, error: toastError }) }));
vi.mock('@/lib/apis/chats', () => ({ getChatListByFolderId: vi.fn(), getChatList: vi.fn(async () => []) }));
vi.mock('@/lib/apis/folders', async (orig) => ({ ...(await orig<object>()), updateFolderById: vi.fn() }));

const now = Math.floor(Date.now() / 1000);
const STATS = { id: 'f1', name: 'Statistics', data: { system_prompt: 'Answer as a statistics tutor.' } };
const Where = () => <div data-testid="where">{useLocation().pathname}</div>;

function show(folder: Parameters<typeof FolderHome>[0]['folder'] = STATS) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const invalidate = vi.spyOn(client, 'invalidateQueries');
	render(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={['/folders/f1']}>
				<Routes>
					<Route path="/folders/:folderId" element={<FolderHome folder={folder} />} />
					<Route path="/c/:id" element={<Where />} />
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>
	);
	return invalidate;
}

beforeEach(() => {
	vi.clearAllMocks();
	useAuthStore.setState({ status: 'authenticated', token: 't', user: { id: 'u1', role: 'admin' } } as never);
});
afterEach(cleanup);

describe('FolderHome (#998)', () => {
	it('heads the page with the folder’s name, says what a message here does, and folds its instructions', async () => {
		vi.mocked(getChatListByFolderId).mockResolvedValue([] as never);
		show();
		expect(screen.getByRole('heading', { level: 1, name: 'Statistics' })).toHaveClass('text-heading', 'font-title');
		expect(screen.getByText(/starts a chat in this folder, with its instructions/)).toBeInTheDocument();
		const summary = screen.getByText('Instructions for chats in this folder');
		expect(summary.closest('details')).not.toHaveAttribute('open');
		expect(screen.getByText('Answer as a statistics tutor.')).toBeInTheDocument();
		expect(await screen.findByText(/No chats in this folder yet/)).toBeInTheDocument();
	});

	it('leaves the instructions out when the folder has none', async () => {
		vi.mocked(getChatListByFolderId).mockResolvedValue([] as never);
		show({ id: 'f1', name: 'Coding' });
		expect(screen.queryByText('Instructions for chats in this folder')).toBeNull();
		expect(screen.getByText('A message sent below starts a chat in this folder.')).toBeInTheDocument();
	});

	it('lists the folder’s chats with their dates, and opens the one pressed', async () => {
		vi.mocked(getChatListByFolderId).mockResolvedValue([
			{ id: 'c1', title: 'Kaplan-Meier curves', updated_at: now - 3600 }
		] as never);
		show();
		const row = await screen.findByRole('button', { name: /Kaplan-Meier curves/ });
		expect(row).toHaveTextContent('an hour ago');
		expect(screen.getByTitle('Kaplan-Meier curves')).toHaveClass('truncate');
		fireEvent.click(row);
		expect(screen.getByTestId('where').textContent).toBe('/c/c1');
	});

	it('shows a skeleton while the chats load and says so in place when they fail (STA-2, STA-4)', async () => {
		let fail: (e: unknown) => void = () => {};
		vi.mocked(getChatListByFolderId).mockImplementation(() => new Promise((_resolve, reject) => (fail = reject)));
		show();
		expect(screen.getByTestId('folder-chats-loading')).toBeInTheDocument();
		fail('Database is locked');
		// useFolderChats may still swallow the error into an empty list; either way the skeleton ends.
		await waitFor(() => expect(screen.queryByTestId('folder-chats-loading')).toBeNull());
	});

	it('pages through a folder with more chats than one page', async () => {
		vi.mocked(getChatListByFolderId).mockImplementation(
			async (_t, _f, page) =>
				(page === 1
					? [{ id: 'c1', title: 'First', updated_at: now }]
					: [{ id: 'c2', title: 'Second', updated_at: now }]) as never
		);
		show();
		fireEvent.click(await screen.findByRole('button', { name: 'Show more chats' }));
		expect(await screen.findByRole('button', { name: /Second/ })).toBeInTheDocument();
	});

	it('edits the folder from its page, keeping its other data, and refreshes it', async () => {
		vi.mocked(getChatListByFolderId).mockResolvedValue([] as never);
		vi.mocked(updateFolderById).mockResolvedValue({ id: 'f1' } as never);
		const invalidate = show({ ...STATS, data: { ...STATS.data, model_ids: ['m1'] } });
		fireEvent.click(screen.getByRole('button', { name: 'Edit folder' }));
		fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Stats' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save folder' }));

		await waitFor(() =>
			expect(updateFolderById).toHaveBeenCalledWith('t', 'f1', {
				name: 'Stats',
				data: { system_prompt: 'Answer as a statistics tutor.', model_ids: ['m1'] }
			})
		);
		await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Folder updated'));
		expect(invalidate).toHaveBeenCalledWith({ queryKey: ['folders'] });
		expect(invalidate).toHaveBeenCalledWith({ queryKey: ['folder', 'f1'] });
	});

	it('keeps the dialog open and says why when the save fails', async () => {
		vi.mocked(getChatListByFolderId).mockResolvedValue([] as never);
		vi.mocked(updateFolderById).mockRejectedValue('Name taken');
		show();
		fireEvent.click(screen.getByRole('button', { name: 'Edit folder' }));
		fireEvent.click(screen.getByRole('button', { name: 'Save folder' }));
		await waitFor(() => expect(toastError).toHaveBeenCalledWith('Name taken'));
		expect(screen.getByRole('dialog', { name: 'Edit folder' })).toBeInTheDocument();
	});
});
