import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useAuthStore } from '@/lib/stores/authStore';
import { KnowledgeBasePage } from './KnowledgeBasePage';
import { KB_FILE_MOVE } from './knowledgeFiles';

// The server side of one knowledge base: 30 files a page, newest first, and
// one directory listed on every page. The mocks below edit it the way the
// real endpoints would.
const state = vi.hoisted(() => ({ files: [] as { id: string; meta: { name: string } }[] }));

vi.mock('@/lib/apis/knowledge', () => ({
	getKnowledgeById: vi.fn(async () => ({
		id: 'kb1',
		name: 'KB',
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
	getFileById: vi.fn(),
	renameFileById: vi.fn(),
	updateFileDataContentById: vi.fn()
}));

const renderPage = () =>
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<TooltipProvider>
				<MemoryRouter initialEntries={['/workspace/knowledge/kb1']}>
					<Routes>
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

beforeEach(() => {
	useAuthStore.setState({
		token: 't',
		user: { id: 'u', email: 'e', name: 'n', role: 'user', profile_image_url: '' }
	} as never);
	state.files = Array.from({ length: 31 }, (_, i) => ({ id: `f${i + 1}`, meta: { name: `file${i + 1}.txt` } }));
});
afterEach(() => vi.clearAllMocks());

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
		state.files = Array.from({ length: 61 }, (_, i) => ({ id: `f${i + 1}`, meta: { name: `file${i + 1}.txt` } }));
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
		const input = container.ownerDocument.getElementById('files-input') as HTMLInputElement;
		fireEvent.change(input, { target: { files: [new File(['hello'], 'notes.txt', { type: 'text/plain' })] } });
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
});
