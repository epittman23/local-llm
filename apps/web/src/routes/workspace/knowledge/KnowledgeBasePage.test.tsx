import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { searchKnowledgeFilesById, updateKnowledgeById } from '@/lib/apis/knowledge';
import { useAuthStore } from '@/lib/stores/authStore';
import { KnowledgeBasePage } from './KnowledgeBasePage';
import { KB_FILE_MOVE } from './knowledgeFiles';

// The server side of one knowledge base: 30 files a page, newest first, and
// one directory listed on every page. The mocks below edit it the way the
// real endpoints would.
const state = vi.hoisted(() => ({ name: 'KB', files: [] as { id: string; meta: { name: string } }[] }));

vi.mock('@/lib/apis/knowledge', () => ({
	getKnowledgeById: vi.fn(async () => ({
		id: 'kb1',
		name: state.name,
		description: 'desc',
		write_access: true,
		access_grants: []
	})),
	searchKnowledgeFilesById: vi.fn(async (...args: unknown[]) => {
		const page = args[6] as number;
		return {
			items: state.files.slice((page - 1) * 30, page * 30),
			total: state.files.length,
			directories: [{ id: 'd1', name: 'Folder', created_at: 0, updated_at: 0 }],
			breadcrumbs: []
		};
	}),
	getPendingKnowledgeFiles: vi.fn(async () => []),
	removeFileFromKnowledgeById: vi.fn(async (_t: string, _kb: string, fileId: string) => {
		state.files = state.files.filter((f) => f.id !== fileId);
		return { id: 'kb1' };
	}),
	moveFileInKnowledge: vi.fn(async (_t: string, _kb: string, fileId: string) => {
		// Moved into the directory: it leaves the listing of the root.
		state.files = state.files.filter((f) => f.id !== fileId);
		return { id: fileId };
	}),
	resetKnowledgeById: vi.fn(async () => {
		state.files = [];
		return { id: 'kb1' };
	}),
	updateKnowledgeById: vi.fn(),
	createKnowledgeDirectory: vi.fn(),
	deleteKnowledgeDirectory: vi.fn(),
	updateKnowledgeAccessGrants: vi.fn(),
	updateKnowledgeDirectory: vi.fn(),
	addFileToKnowledgeById: vi.fn(),
	syncKnowledgeCleanup: vi.fn(),
	syncKnowledgeDiff: vi.fn()
}));

vi.mock('@/lib/apis/files', () => ({
	uploadFile: vi.fn(async (_t: string, file: File) => {
		const f = { id: `new-${file.name}`, meta: { name: file.name } };
		state.files = [f, ...state.files];
		return f;
	}),
	getFileById: vi.fn(async (_t: string, fileId: string) => ({ id: fileId, data: { content: 'text' } })),
	renameFileById: vi.fn(),
	updateFileDataContentById: vi.fn(async (_t: string, fileId: string) => ({ id: fileId }))
}));

const renderPage = (client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) =>
	render(
		<QueryClientProvider client={client}>
			<TooltipProvider>
				<MemoryRouter initialEntries={['/workspace/knowledge/kb1']}>
					<Routes>
						<Route path="/workspace/knowledge" element={null} />
						<Route path="/workspace/knowledge/:id" element={<KnowledgeBasePage />} />
					</Routes>
				</MemoryRouter>
			</TooltipProvider>
		</QueryClientProvider>
	);

/** Opens the knowledge base and goes to page 2, where only file31 is listed. */
const openPageTwo = async () => {
	const view = renderPage();
	await screen.findByText('file1.txt');
	fireEvent.click(screen.getByText('2'));
	await screen.findByText('file31.txt');
	expect(screen.queryByText('file1.txt')).toBeNull();
	return view;
};

const sixtyOneFiles = () =>
	Array.from({ length: 61 }, (_, i) => ({ id: `f${i + 1}`, meta: { name: `file${i + 1}.txt` } }));

const upload = (container: HTMLElement, name: string) => {
	const input = container.ownerDocument.getElementById('files-input') as HTMLInputElement;
	fireEvent.change(input, { target: { files: [new File(['hello'], name, { type: 'text/plain' })] } });
};

beforeEach(() => {
	useAuthStore.setState({
		token: 't',
		user: { id: 'u', email: 'e', name: 'n', role: 'user', profile_image_url: '' }
	} as never);
	state.name = 'KB';
	state.files = Array.from({ length: 31 }, (_, i) => ({ id: `f${i + 1}`, meta: { name: `file${i + 1}.txt` } }));
});
afterEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
});

describe('KnowledgeBasePage file filter (#230)', () => {
	afterEach(() => {
		delete localStorage.workspaceViewOption;
	});

	it("opens unfiltered, whatever the workspace lists' View setting is", async () => {
		// Set on a list page; it filtered this page too, so a shared base looked empty.
		localStorage.workspaceViewOption = 'created';
		renderPage();

		await screen.findByText('file1.txt');
		expect(vi.mocked(searchKnowledgeFilesById).mock.calls[0][3]).toBe('');
		expect((screen.getByLabelText('View') as HTMLSelectElement).value).toBe('');
	});
});

describe('KnowledgeBasePage pagination after the list changes (#229)', () => {
	it('goes back to page 1 after deleting the only file on page 2', async () => {
		await openPageTwo();
		fireEvent.pointerDown(screen.getByLabelText('file31.txt menu'), {
			button: 0,
			ctrlKey: false,
			pointerType: 'mouse'
		});
		fireEvent.click(await screen.findByText('Delete'));
		expect(await screen.findByText('file1.txt')).toBeInTheDocument();
		expect(screen.queryByText('No content found')).toBeNull();
	});

	it('goes back to page 1 after any delete, as the original did, even with page 2 still filled', async () => {
		state.files = sixtyOneFiles();
		await openPageTwo();
		fireEvent.pointerDown(screen.getByLabelText('file31.txt menu'), {
			button: 0,
			ctrlKey: false,
			pointerType: 'mouse'
		});
		fireEvent.click(await screen.findByText('Delete'));
		expect(await screen.findByText('file1.txt')).toBeInTheDocument();
		expect(screen.queryByText('file32.txt')).toBeNull();
	});

	it('lists a file uploaded after a reset made from page 2', async () => {
		const { container } = await openPageTwo();
		fireEvent.pointerDown(screen.getByLabelText('Add Content'), { button: 0, ctrlKey: false, pointerType: 'mouse' });
		fireEvent.click(await screen.findByText('Reset'));
		fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
		await waitFor(() => expect(screen.queryByText('file31.txt')).toBeNull());
		upload(container, 'notes.txt');
		// The in-flight row also reads "notes.txt", until the upload settles and
		// the reloaded list (header "1 files") replaces it.
		await screen.findByText('1 files');
		await waitFor(() => {
			expect(screen.queryByText('No content found')).toBeNull();
			expect(screen.getByText('notes.txt')).toBeInTheDocument();
		});
	});

	it('moves back to the last page when moving a file away empties the page it was on', async () => {
		await openPageTwo();
		const folder = screen.getByLabelText('Open Folder').closest('[role="listitem"]') as HTMLElement;
		fireEvent.drop(folder, {
			dataTransfer: {
				types: [KB_FILE_MOVE],
				getData: (type: string) => (type === KB_FILE_MOVE ? JSON.stringify({ fileId: 'f31' }) : '')
			}
		});
		expect(await screen.findByText('file1.txt')).toBeInTheDocument();
		expect(screen.queryByText('file31.txt')).toBeNull();
	});

	it('goes back to page 1 after an upload, as the original did, even with page 2 still filled', async () => {
		state.files = sixtyOneFiles();
		const { container } = await openPageTwo();
		upload(container, 'notes.txt');
		expect(await screen.findByText('62 files')).toBeInTheDocument();
		await waitFor(() => {
			expect(screen.getByText('file1.txt')).toBeInTheDocument();
			expect(screen.queryByText('file31.txt')).toBeNull();
		});
	});

	it('goes back to page 1 after saving a file edit, as the original did', async () => {
		state.files = sixtyOneFiles();
		await openPageTwo();
		fireEvent.click(screen.getByRole('button', { name: 'Open file31.txt' }));
		const save = await screen.findByRole('button', { name: 'Save' });
		await waitFor(() => expect(save).toBeEnabled());
		fireEvent.click(save);
		expect(await screen.findByText('file1.txt')).toBeInTheDocument();
		expect(screen.queryByText('file32.txt')).toBeNull();
	});

	it('reaches page 2 again after a delete there and an upload refill it', async () => {
		// The delete reloads while page 2 is still the page shown, which caches
		// page 2 as empty with 30 files; that stale entry must not bounce the
		// next visit to page 2 back to page 1.
		const { container } = await openPageTwo();
		fireEvent.pointerDown(screen.getByLabelText('file31.txt menu'), {
			button: 0,
			ctrlKey: false,
			pointerType: 'mouse'
		});
		fireEvent.click(await screen.findByText('Delete'));
		expect(await screen.findByText('file1.txt')).toBeInTheDocument();
		await waitFor(() => expect(screen.queryByRole('navigation')).toBeNull());
		upload(container, 'notes.txt');
		await screen.findByText('31 files');
		fireEvent.click(await screen.findByText('2'));
		expect(await screen.findByText('file30.txt')).toBeInTheDocument();
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(screen.getByText('file30.txt')).toBeInTheDocument();
		expect(screen.queryByText('file1.txt')).toBeNull();
	});
});

describe('KnowledgeBasePage name and description autosave (#228)', () => {
	/** Opens the knowledge base, then hands the clock to the test. */
	const openWithFakeTimers = async () => {
		vi.mocked(updateKnowledgeById).mockResolvedValue({ id: 'kb1' } as never);
		renderPage();
		await screen.findByText('file1.txt');
		vi.useFakeTimers();
	};

	it('saves an edit made just before leaving with Back instead of dropping it', async () => {
		await openWithFakeTimers();
		fireEvent.change(screen.getByLabelText('Knowledge Name'), { target: { value: 'Renamed' } });
		fireEvent.click(screen.getByText('Back'));
		expect(updateKnowledgeById).toHaveBeenCalledTimes(1);
		expect(updateKnowledgeById).toHaveBeenCalledWith(
			't',
			'kb1',
			expect.objectContaining({ name: 'Renamed', description: 'desc' })
		);
	});

	it('saves only the last of several quick edits when leaving', async () => {
		await openWithFakeTimers();
		fireEvent.change(screen.getByLabelText('Knowledge Name'), { target: { value: 'Renamed' } });
		fireEvent.change(screen.getByLabelText('Knowledge Description'), { target: { value: 'new desc' } });
		fireEvent.click(screen.getByText('Back'));
		expect(updateKnowledgeById).toHaveBeenCalledTimes(1);
		expect(updateKnowledgeById).toHaveBeenCalledWith(
			't',
			'kb1',
			expect.objectContaining({ name: 'Renamed', description: 'new desc' })
		);
	});

	it('does not save again on leaving once the pause has saved the edit', async () => {
		await openWithFakeTimers();
		fireEvent.change(screen.getByLabelText('Knowledge Name'), { target: { value: 'Renamed' } });
		vi.advanceTimersByTime(1000);
		expect(updateKnowledgeById).toHaveBeenCalledTimes(1);
		fireEvent.click(screen.getByText('Back'));
		expect(updateKnowledgeById).toHaveBeenCalledTimes(1);
	});

	it('saves nothing on leaving when nothing was edited', async () => {
		await openWithFakeTimers();
		fireEvent.click(screen.getByText('Back'));
		expect(updateKnowledgeById).not.toHaveBeenCalled();
	});

	it('still refuses an emptied name on leaving, saying so', async () => {
		const error = vi.spyOn(toast, 'error');
		await openWithFakeTimers();
		fireEvent.change(screen.getByLabelText('Knowledge Name'), { target: { value: ' ' } });
		fireEvent.click(screen.getByText('Back'));
		expect(updateKnowledgeById).not.toHaveBeenCalled();
		expect(error).toHaveBeenCalledWith('Please fill in all fields.');
	});

	it('shows the saved name when the knowledge base is opened again from the cache', async () => {
		vi.mocked(updateKnowledgeById).mockImplementation(async (_t, _id, form) => {
			state.name = (form as { name: string }).name;
			return { id: 'kb1' } as never;
		});
		const success = vi.spyOn(toast, 'success');
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const view = renderPage(client);
		await screen.findByText('file1.txt');
		fireEvent.change(screen.getByLabelText('Knowledge Name'), { target: { value: 'Renamed' } });
		view.unmount();
		await waitFor(() => expect(success).toHaveBeenCalledWith('Knowledge updated successfully'));
		renderPage(client);
		await screen.findByText('file1.txt');
		// The background refetch has settled too, so a stale name would stay put.
		await waitFor(() => expect(client.isFetching()).toBe(0));
		expect(screen.getByLabelText('Knowledge Name')).toHaveValue('Renamed');
	});

	it('reports a save made on leaving that the server rejects', async () => {
		const error = vi.spyOn(toast, 'error');
		await openWithFakeTimers();
		vi.mocked(updateKnowledgeById).mockRejectedValue('Name taken');
		fireEvent.change(screen.getByLabelText('Knowledge Name'), { target: { value: 'Renamed' } });
		fireEvent.click(screen.getByText('Back'));
		await vi.waitFor(() => expect(error).toHaveBeenCalledWith('Name taken'));
	});
});
