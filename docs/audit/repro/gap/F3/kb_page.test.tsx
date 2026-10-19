import { QueryProvider } from '@/lib/query/QueryProvider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { act, fireEvent, render, screen, waitFor } from '../../../../../apps/web/node_modules/@testing-library/react';
import { MemoryRouter, Route, Routes } from '../../../../../apps/web/node_modules/react-router/dist/development/index.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ files: [] as { id: string; meta: { name: string } }[], updateCalls: [] as unknown[] }));

vi.mock('@/lib/apis/knowledge', () => ({
	getKnowledgeById: vi.fn(async () => ({ id: 'kb1', name: 'KB', description: 'desc', write_access: true, access_grants: [] })),
	searchKnowledgeFilesById: vi.fn(async (_t, _id, _q, _v, _o, _d, page: number) => ({
		items: state.files.slice((page - 1) * 30, page * 30),
		total: state.files.length,
		directories: [],
		breadcrumbs: []
	})),
	getPendingKnowledgeFiles: vi.fn(async () => []),
	removeFileFromKnowledgeById: vi.fn(async (_t, _kb, fileId: string) => {
		state.files = state.files.filter((f) => f.id !== fileId);
		return { id: 'kb1' };
	}),
	updateKnowledgeById: vi.fn(async (...args: unknown[]) => {
		state.updateCalls.push(args);
		return { id: 'kb1' };
	}),
	createKnowledgeDirectory: vi.fn(),
	deleteKnowledgeDirectory: vi.fn(),
	moveFileInKnowledge: vi.fn(),
	resetKnowledgeById: vi.fn(async () => {
		state.files = [];
		return { id: 'kb1' };
	}),
	updateKnowledgeAccessGrants: vi.fn(),
	updateKnowledgeDirectory: vi.fn(),
	addFileToKnowledgeById: vi.fn(),
	syncKnowledgeCleanup: vi.fn(),
	syncKnowledgeDiff: vi.fn(),
	testExternalKnowledgeRetrieval: vi.fn()
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

import { useAuthStore } from '@/lib/stores/authStore';
import { KnowledgeBasePage } from '@/routes/workspace/knowledge/KnowledgeBasePage';

const renderPage = () => {
	return render(
		<QueryProvider><TooltipProvider>
			<MemoryRouter initialEntries={['/workspace/knowledge/kb1']}>
				<Routes>
					<Route path="/workspace/knowledge/:id" element={<KnowledgeBasePage />} />
					<Route path="/workspace/knowledge" element={<div>LIST PAGE</div>} />
				</Routes>
			</MemoryRouter>
		</TooltipProvider></QueryProvider>
	);
};

beforeEach(() => {
	useAuthStore.setState({ token: 't', user: { id: 'u', email: 'e', name: 'n', role: 'user', profile_image_url: '' } } as never);
	state.files = Array.from({ length: 31 }, (_, i) => ({ id: `f${i + 1}`, meta: { name: `file${i + 1}.txt` } }));
	state.updateCalls = [];
});
afterEach(() => vi.clearAllMocks());

it('deleting the only file on page 2 leaves an empty page with no pagination to get back', async () => {
	renderPage();
	await screen.findByText('file1.txt');
	fireEvent.click(screen.getByText('2'));
	await screen.findByText('file31.txt');
	expect(screen.getByRole('navigation')).toBeTruthy();
	expect(screen.queryByText('file1.txt')).toBeNull();
	const trigger = screen.getByLabelText('file31.txt menu');
	fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
	fireEvent.click(await screen.findByText('Delete'));
	await screen.findByText('No content found');
	console.log('pagination present after delete:', screen.queryByRole('navigation') !== null, '| file1 visible:', screen.queryByText('file1.txt') !== null);
	expect(screen.queryByRole('navigation')).toBeNull();
	expect(screen.queryByText('file1.txt')).toBeNull();
});

it('a name edit followed within 1s by Back is never saved', async () => {
	renderPage();
	const name = await screen.findByLabelText('Knowledge Name');
	fireEvent.change(name, { target: { value: 'Renamed KB' } });
	fireEvent.click(screen.getByText('Back'));
	await screen.findByText('LIST PAGE');
	await act(async () => {
		await new Promise((r) => setTimeout(r, 1500));
	});
	console.log('updateKnowledgeById calls after Back:', state.updateCalls.length);
	expect(state.updateCalls.length).toBe(0);
});

it('control: the same edit without leaving is saved after 1s', async () => {
	renderPage();
	const name = await screen.findByLabelText('Knowledge Name');
	fireEvent.change(name, { target: { value: 'Renamed KB' } });
	await act(async () => {
		await new Promise((r) => setTimeout(r, 1500));
	});
	expect(state.updateCalls.length).toBe(1);
});

it('reset from page 2, then upload one file: header says 1 files, list says No content found, no pagination', async () => {
	const { container } = renderPage();
	await screen.findByText('file1.txt');
	fireEvent.click(screen.getByText('2'));
	await screen.findByText('file31.txt');
	fireEvent.pointerDown(screen.getByLabelText('Add Content'), { button: 0, ctrlKey: false, pointerType: 'mouse' });
	fireEvent.click(await screen.findByText('Reset'));
	fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
	await screen.findByText('No content found');
	const input = container.ownerDocument.getElementById('files-input') as HTMLInputElement;
	const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
	fireEvent.change(input, { target: { files: [file] } });
	await screen.findByText('1 files');
	await waitFor(() => expect(screen.getByText('No content found')).toBeTruthy());
	expect(screen.queryByText('notes.txt')).toBeNull();
	expect(screen.queryByRole('navigation')).toBeNull();
});

it('a view filter chosen on any workspace list pre-filters a knowledge base the user opens', async () => {
	localStorage.workspaceViewOption = 'created';
	const { searchKnowledgeFilesById } = await import('@/lib/apis/knowledge');
	renderPage();
	await waitFor(() => expect(searchKnowledgeFilesById).toHaveBeenCalled());
	const viewArg = (searchKnowledgeFilesById as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][3];
	delete localStorage.workspaceViewOption;
	expect(viewArg).toBe('created');
});
