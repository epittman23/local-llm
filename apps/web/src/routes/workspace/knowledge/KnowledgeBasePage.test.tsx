import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { AccessGrant } from '@/lib/access/accessGrants';
import { getFileById, uploadFile } from '@/lib/apis/files';
import {
	createKnowledgeDirectory,
	deleteKnowledgeDirectory,
	getKnowledgeById,
	removeFileFromKnowledgeById,
	resetKnowledgeById,
	searchKnowledgeFilesById,
	updateKnowledgeAccessGrants,
	updateKnowledgeById
} from '@/lib/apis/knowledge';
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

// The access dialog, reduced to what the page gives it and what it sends back.
const accessDialog = vi.hoisted(() => ({ send: [] as AccessGrant[] }));
vi.mock('@/components/common/AccessControlModal', () => ({
	AccessControlModal: ({
		accessGrants,
		onChange
	}: {
		accessGrants: AccessGrant[];
		onChange: (grants: AccessGrant[]) => Promise<void>;
	}) => (
		<div>
			<output data-testid="shown-grants">{accessGrants.map((g) => g.principal_id).join(',')}</output>
			<button type="button" onClick={() => void onChange(accessDialog.send)}>
				Send grants
			</button>
		</div>
	)
}));

const accounts = vi.hoisted(() => ({ total: 1 }));
vi.mock('@/lib/apis/users', () => ({ searchUsers: vi.fn(async () => ({ total: accounts.total })) }));

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

const openMenu = (label: string) =>
	fireEvent.pointerDown(screen.getByLabelText(label), { button: 0, ctrlKey: false, pointerType: 'mouse' });

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
	accounts.total = 1;
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
		// One account: there is nobody else's to filter by, so no View menu (WRD-4, S4-D1).
		expect(screen.queryByRole('button', { name: /^View:/ })).toBeNull();
	});
});

describe('KnowledgeBasePage header and toolbar (#1017, S4-D1)', () => {
	it('offers View and Access, and names who added each file, once a second account exists', async () => {
		accounts.total = 2;
		state.files = [{ id: 'f1', meta: { name: 'file1.txt' }, user: { name: 'sam' } } as never];
		renderPage();
		expect(await screen.findByRole('button', { name: 'View: All' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Access' })).toBeInTheDocument();
		expect(screen.getByText(/By Sam/)).toBeInTheDocument();
	});

	it('hides Access and who added each file while the install has one account', async () => {
		state.files = [{ id: 'f1', meta: { name: 'file1.txt' }, user: { name: 'sam' } } as never];
		renderPage();
		await screen.findByText('file1.txt');
		expect(screen.queryByRole('button', { name: 'Access' })).toBeNull();
		expect(screen.queryByText(/By Sam/)).toBeNull();
	});

	it('sorts with one menu over the server sort key and direction', async () => {
		renderPage();
		await screen.findByText('file1.txt');
		fireEvent.pointerDown(screen.getByRole('button', { name: 'Sort: Recently updated' }), {
			button: 0,
			ctrlKey: false,
			pointerType: 'mouse'
		});
		fireEvent.click(await screen.findByText('Name, A to Z'));
		await waitFor(() => {
			const last = vi.mocked(searchKnowledgeFilesById).mock.calls.at(-1) ?? [];
			expect([last[4], last[5]]).toEqual(['name', 'asc']);
		});
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
		fireEvent.click(await screen.findByText('Remove'));
		fireEvent.click(await screen.findByRole('button', { name: 'Remove file' }));
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
		fireEvent.click(await screen.findByText('Remove'));
		fireEvent.click(await screen.findByRole('button', { name: 'Remove file' }));
		expect(await screen.findByText('file1.txt')).toBeInTheDocument();
		expect(screen.queryByText('file32.txt')).toBeNull();
	});

	it('lists a file uploaded after a reset made from page 2', async () => {
		const { container } = await openPageTwo();
		fireEvent.pointerDown(screen.getByLabelText('Add content'), { button: 0, ctrlKey: false, pointerType: 'mouse' });
		fireEvent.click(await screen.findByText('Reset knowledge base', { selector: '[role=menuitem]' }));
		fireEvent.click(await screen.findByRole('button', { name: 'Reset knowledge base' }));
		await waitFor(() => expect(screen.queryByText('file31.txt')).toBeNull());
		upload(container, 'notes.txt');
		// The in-flight row also reads "notes.txt", until the upload settles and
		// the reloaded list (header "1 file") replaces it.
		await screen.findByText(/\b1 file$/);
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
		expect(await screen.findByText(/62 files/)).toBeInTheDocument();
		await waitFor(() => {
			expect(screen.getByText('file1.txt')).toBeInTheDocument();
			expect(screen.queryByText('file31.txt')).toBeNull();
		});
	});

	it('goes back to page 1 after saving a file edit, as the original did', async () => {
		state.files = sixtyOneFiles();
		await openPageTwo();
		fireEvent.click(screen.getByRole('button', { name: 'Open file31.txt' }));
		fireEvent.click(await screen.findByRole('button', { name: 'Edit text' }));
		fireEvent.change(await screen.findByLabelText('File text'), { target: { value: 'edited' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save text' }));
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
		fireEvent.click(await screen.findByText('Remove'));
		fireEvent.click(await screen.findByRole('button', { name: 'Remove file' }));
		expect(await screen.findByText('file1.txt')).toBeInTheDocument();
		await waitFor(() => expect(screen.queryByRole('navigation')).toBeNull());
		upload(container, 'notes.txt');
		await screen.findByText(/\b31 files/);
		fireEvent.click(await screen.findByText('2'));
		expect(await screen.findByText('file30.txt')).toBeInTheDocument();
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(screen.getByText('file30.txt')).toBeInTheDocument();
		expect(screen.queryByText('file1.txt')).toBeNull();
	});
});

describe('KnowledgeBasePage name and description dialog (#228, #1017)', () => {
	/** Opens the knowledge base and its Edit name and description dialog. */
	const openDialog = async () => {
		vi.mocked(updateKnowledgeById).mockResolvedValue({ id: 'kb1' } as never);
		renderPage();
		await screen.findByText('file1.txt');
		openMenu('More actions');
		fireEvent.click(await screen.findByText('Edit name and description'));
		return screen.findByRole('dialog', { name: 'Edit name and description' });
	};

	it('saves the name and description from the dialog, and only those', async () => {
		await openDialog();
		fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
		await waitFor(() =>
			expect(updateKnowledgeById).toHaveBeenCalledExactlyOnceWith('t', 'kb1', { name: 'Renamed', description: 'desc' })
		);
		expect(await screen.findByRole('heading', { name: 'Renamed' })).toBeInTheDocument();
	});

	it('saves a changed description, trimmed, and closes', async () => {
		await openDialog();
		fireEvent.change(screen.getByLabelText('Description (optional)'), { target: { value: ' new desc ' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
		await waitFor(() =>
			expect(updateKnowledgeById).toHaveBeenCalledWith('t', 'kb1', { name: 'KB', description: 'new desc' })
		);
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
	});

	it('Cancel drops the edits and saves nothing', async () => {
		await openDialog();
		fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } });
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		expect(updateKnowledgeById).not.toHaveBeenCalled();
		expect(screen.getByRole('heading', { name: 'KB' })).toBeInTheDocument();
	});

	it('keeps Save changes off until something changed', async () => {
		await openDialog();
		expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
		fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'KB2' } });
		expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
	});

	it('saves nothing after a pause or on leaving: there is no save-after-a-pause', async () => {
		vi.mocked(updateKnowledgeById).mockResolvedValue({ id: 'kb1' } as never);
		renderPage();
		await screen.findByText('file1.txt');
		window.dispatchEvent(new Event('pagehide'));
		fireEvent.click(screen.getByText('Back'));
		expect(updateKnowledgeById).not.toHaveBeenCalled();
	});

	it('refuses an empty name under the field, saying so', async () => {
		await openDialog();
		fireEvent.change(screen.getByLabelText('Name'), { target: { value: ' ' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
		expect(await screen.findByText('Give the knowledge base a name.')).toBeInTheDocument();
		expect(screen.getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true');
		expect(updateKnowledgeById).not.toHaveBeenCalled();
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
		openMenu('More actions');
		fireEvent.click(await screen.findByText('Edit name and description'));
		fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Renamed' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
		await waitFor(() => expect(success).toHaveBeenCalledWith('Saved "Renamed"'));
		view.unmount();
		renderPage(client);
		await screen.findByText('file1.txt');
		// The background refetch has settled too, so a stale name would stay put.
		await waitFor(() => expect(client.isFetching()).toBe(0));
		expect(screen.getByRole('heading', { name: 'Renamed' })).toBeInTheDocument();
	});

	it('reports a save the server rejects and keeps the dialog open', async () => {
		const error = vi.spyOn(toast, 'error');
		await openDialog();
		vi.mocked(updateKnowledgeById).mockRejectedValue('Name taken');
		fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
		await waitFor(() =>
			expect(error).toHaveBeenCalledWith("Couldn't save the name and description. Try again.", {
				description: expect.anything()
			})
		);
		expect(screen.getByRole('dialog', { name: 'Edit name and description' })).toBeInTheDocument();
	});
});

describe('KnowledgeBasePage access dialog (#522)', () => {
	const grant = (principal_id: string): AccessGrant =>
		({ principal_type: 'user', principal_id, permission: 'read' }) as AccessGrant;
	const shown = () => screen.getByTestId('shown-grants').textContent;
	const send = (grants: AccessGrant[]) => {
		accessDialog.send = grants;
		fireEvent.click(screen.getByText('Send grants'));
	};
	const open = async () => {
		renderPage();
		await screen.findByText('file1.txt');
	};

	it('shows the grants the server stored, and warns when it dropped some', async () => {
		vi.mocked(updateKnowledgeAccessGrants).mockResolvedValue({ id: 'kb1', access_grants: [grant('a')] });
		const warning = vi.spyOn(toast, 'warning');
		const success = vi.spyOn(toast, 'success');
		await open();

		send([grant('a'), grant('*')]);

		await waitFor(() => expect(shown()).toBe('a'));
		expect(warning).toHaveBeenCalledWith('Some access settings were not saved: you are not allowed to share this way.');
		expect(success).not.toHaveBeenCalled();
	});

	it('says Saved when the server kept every grant', async () => {
		vi.mocked(updateKnowledgeAccessGrants).mockResolvedValue({ id: 'kb1', access_grants: [grant('a')] });
		const success = vi.spyOn(toast, 'success');
		await open();

		send([grant('a')]);

		await waitFor(() => expect(success).toHaveBeenCalledWith('Access saved'));
		expect(shown()).toBe('a');
	});

	it('shows the sent grants at once, before the server answers', async () => {
		vi.mocked(updateKnowledgeAccessGrants).mockReturnValue(new Promise(() => undefined));
		await open();

		send([grant('a')]);

		await waitFor(() => expect(shown()).toBe('a'));
	});

	it('shows only the latest of two saves whose answers arrive in reverse order', async () => {
		const answers: ((v: unknown) => void)[] = [];
		vi.mocked(updateKnowledgeAccessGrants).mockImplementation(() => new Promise((r) => answers.push(r)));
		await open();
		send([grant('a')]);
		await waitFor(() => expect(answers).toHaveLength(1));
		send([grant('b')]);
		await waitFor(() => expect(answers).toHaveLength(2));

		answers[1]({ id: 'kb1', access_grants: [grant('b')] });
		await waitFor(() => expect(shown()).toBe('b'));
		answers[0]({ id: 'kb1', access_grants: [grant('a')] });
		await new Promise((r) => setTimeout(r, 0));

		expect(shown()).toBe('b');
	});

	it('puts the previous grants back when the save fails, and says why', async () => {
		vi.mocked(updateKnowledgeAccessGrants).mockRejectedValue('Not allowed');
		const error = vi.spyOn(toast, 'error');
		await open();

		send([grant('a')]);

		await waitFor(() =>
			expect(error).toHaveBeenCalledWith("Couldn't save who has access. The previous access is back.", {
				description: expect.objectContaining({ props: { detail: 'Not allowed' } })
			})
		);
		expect(shown()).toBe('');
	});

	it('leaves a newer save alone when an older one fails', async () => {
		let failFirst: (e: unknown) => void = () => undefined;
		vi.mocked(updateKnowledgeAccessGrants)
			.mockImplementationOnce(() => new Promise((_r, reject) => (failFirst = reject)))
			.mockResolvedValueOnce({ id: 'kb1', access_grants: [grant('b')] });
		const error = vi.spyOn(toast, 'error');
		await open();
		send([grant('a')]);
		send([grant('b')]);
		await waitFor(() => expect(shown()).toBe('b'));

		failFirst('offline');
		await waitFor(() =>
			expect(error).toHaveBeenCalledWith("Couldn't save who has access. The previous access is back.", {
				description: expect.objectContaining({ props: { detail: 'offline' } })
			})
		);

		expect(shown()).toBe('b');
	});

	it('a name edit saved after an access change does not send the grants again', async () => {
		vi.mocked(updateKnowledgeAccessGrants).mockResolvedValue({ id: 'kb1', access_grants: [grant('a')] });
		vi.mocked(updateKnowledgeById).mockResolvedValue({ id: 'kb1' } as never);
		await open();
		send([grant('a')]);
		await waitFor(() => expect(shown()).toBe('a'));
		openMenu('More actions');
		fireEvent.click(await screen.findByText('Edit name and description'));
		fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Renamed' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

		await waitFor(() => expect(updateKnowledgeById).toHaveBeenCalledTimes(1));
		expect(vi.mocked(updateKnowledgeById).mock.calls[0][2]).not.toHaveProperty('access_grants');
	});
});

describe('KnowledgeBasePage destructive actions (#906, #1012)', () => {
	it('asks before removing a file, naming it and what goes with it', async () => {
		const success = vi.spyOn(toast, 'success');
		renderPage();
		await screen.findByText('file1.txt');
		openMenu('file1.txt menu');
		fireEvent.click(await screen.findByText('Remove'));
		const dialog = await screen.findByRole('alertdialog');
		expect(dialog).toHaveTextContent('Remove "file1.txt"?');
		expect(dialog).toHaveTextContent('Its extracted text and embeddings are deleted.');
		expect(removeFileFromKnowledgeById).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole('button', { name: 'Remove file' }));
		await waitFor(() => expect(removeFileFromKnowledgeById).toHaveBeenCalledWith('t', 'kb1', 'f1'));
		await waitFor(() => expect(success).toHaveBeenCalledWith('Removed "file1.txt"'));
	});

	it('removes nothing when the file confirmation is cancelled', async () => {
		renderPage();
		await screen.findByText('file1.txt');
		openMenu('file1.txt menu');
		fireEvent.click(await screen.findByText('Remove'));
		fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
		await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
		expect(removeFileFromKnowledgeById).not.toHaveBeenCalled();
	});

	it('says why a removal failed, with the server text behind Details', async () => {
		const error = vi.spyOn(toast, 'error');
		vi.mocked(removeFileFromKnowledgeById).mockRejectedValueOnce('boom');
		renderPage();
		await screen.findByText('file1.txt');
		openMenu('file1.txt menu');
		fireEvent.click(await screen.findByText('Remove'));
		fireEvent.click(await screen.findByRole('button', { name: 'Remove file' }));
		await waitFor(() =>
			expect(error).toHaveBeenCalledWith('Couldn\'t remove "file1.txt".', { description: expect.anything() })
		);
	});

	it('names the folder, keeps its files unless asked, and says which happens', async () => {
		vi.mocked(deleteKnowledgeDirectory).mockResolvedValue({ status: true });
		renderPage();
		await screen.findByText('file1.txt');
		openMenu('Folder menu');
		fireEvent.click(await screen.findByText('Delete'));
		const dialog = await screen.findByRole('alertdialog');
		expect(dialog).toHaveTextContent('Delete the folder "Folder"?');
		expect(dialog).toHaveTextContent('The files in them move up to the folder above.');
		const box = screen.getByRole('checkbox', { name: 'Also delete the files inside' });
		expect(box).not.toBeChecked();
		fireEvent.click(box);
		expect(dialog).toHaveTextContent('every file in them are deleted');
		fireEvent.click(screen.getByRole('button', { name: 'Delete folder' }));
		await waitFor(() => expect(deleteKnowledgeDirectory).toHaveBeenCalledWith('t', 'kb1', 'd1', false));
	});

	it("moves a deleted folder's files up by default", async () => {
		vi.mocked(deleteKnowledgeDirectory).mockRejectedValueOnce('kept');
		const error = vi.spyOn(toast, 'error');
		renderPage();
		await screen.findByText('file1.txt');
		openMenu('Folder menu');
		fireEvent.click(await screen.findByText('Delete'));
		fireEvent.click(await screen.findByRole('button', { name: 'Delete folder' }));
		await waitFor(() => expect(deleteKnowledgeDirectory).toHaveBeenCalledWith('t', 'kb1', 'd1', true));
		await waitFor(() =>
			expect(error).toHaveBeenCalledWith('Couldn\'t delete the folder "Folder".', { description: expect.anything() })
		);
	});

	it('names the knowledge base in the reset confirmation and says what is lost', async () => {
		renderPage();
		await screen.findByText('file1.txt');
		openMenu('Add content');
		fireEvent.click(await screen.findByText('Reset knowledge base', { selector: '[role=menuitem]' }));
		const dialog = await screen.findByRole('alertdialog');
		expect(dialog).toHaveTextContent('Reset "KB"?');
		expect(dialog).toHaveTextContent(
			'Every file and folder is removed from it, with their extracted text and embeddings.'
		);
		fireEvent.click(screen.getByRole('button', { name: 'Reset knowledge base' }));
		await waitFor(() => expect(resetKnowledgeById).toHaveBeenCalled());
	});
});

describe('KnowledgeBasePage failed uploads (#907)', () => {
	it('keeps a failed upload in the list with its reason, Retry and Dismiss', async () => {
		vi.mocked(uploadFile).mockRejectedValueOnce('Embedding model is not available offline');
		const { container } = renderPage();
		await screen.findByText('file1.txt');
		upload(container, 'notes.txt');
		expect(await screen.findByText('The server refused the upload.')).toBeInTheDocument();
		expect(screen.getByText('Embedding model is not available offline')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Retry notes.txt' })).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Dismiss notes.txt' }));
		await waitFor(() => expect(screen.queryByText('The server refused the upload.')).toBeNull());
	});
});

describe('KnowledgeBasePage missing or failed base (#1095)', () => {
	it('says in place that a base no longer exists, with the way back', async () => {
		vi.mocked(getKnowledgeById).mockResolvedValueOnce(null);
		renderPage();
		expect(await screen.findByRole('heading', { name: 'Knowledge base not found' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Back to Knowledge' })).toBeInTheDocument();
	});

	it('treats the server not-found answer the same way', async () => {
		vi.mocked(getKnowledgeById).mockRejectedValueOnce("We could not find what you're looking for :/");
		renderPage();
		expect(await screen.findByRole('heading', { name: 'Knowledge base not found' })).toBeInTheDocument();
	});

	it('offers to try again when the base could not be loaded', async () => {
		vi.mocked(getKnowledgeById).mockRejectedValueOnce('database down');
		renderPage();
		expect(await screen.findByText("Couldn't load this knowledge base")).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
		expect(await screen.findByRole('heading', { name: 'KB' })).toBeInTheDocument();
	});
});

describe('KnowledgeBasePage header menu (#1017)', () => {
	it('copies the id from the menu instead of showing it', async () => {
		const writeText = vi.fn(async () => undefined);
		Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
		renderPage();
		await screen.findByText('file1.txt');
		expect(screen.queryByText('kb1')).toBeNull();
		openMenu('More actions');
		fireEvent.click(await screen.findByText('Copy ID'));
		await waitFor(() => expect(writeText).toHaveBeenCalledWith('kb1'));
	});

	it('says what an empty base holds and what matches nothing', async () => {
		state.files = [];
		const listing = vi.mocked(searchKnowledgeFilesById).getMockImplementation();
		onTestFinished(() => {
			if (listing) vi.mocked(searchKnowledgeFilesById).mockImplementation(listing);
		});
		vi.mocked(searchKnowledgeFilesById).mockImplementation(async () => ({
			items: [],
			total: 0,
			directories: [],
			breadcrumbs: []
		}));
		renderPage();
		expect(await screen.findByText(/No files yet\./)).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText('Search files'), { target: { value: 'zzz' } });
		expect(await screen.findByText('Nothing matches "zzz".')).toBeInTheDocument();
	});
});

describe('KnowledgeBasePage file sheet (#1096)', () => {
	it('opens on the rendered text, and edits only after Edit text', async () => {
		renderPage();
		fireEvent.click(await screen.findByRole('button', { name: 'Open file1.txt' }));
		expect(await screen.findByRole('heading', { name: 'file1.txt' })).toBeInTheDocument();
		expect(await screen.findByText('text')).toBeInTheDocument();
		expect(screen.queryByLabelText('File text')).toBeNull();
		fireEvent.click(screen.getByRole('button', { name: 'Edit text' }));
		const box = await screen.findByLabelText('File text');
		expect(screen.getByRole('button', { name: 'Save text' })).toBeDisabled();
		fireEvent.change(box, { target: { value: 'changed' } });
		expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
		expect(screen.queryByLabelText('File text')).toBeNull();
		expect(screen.getByText('text')).toBeInTheDocument();
	});

	it('says when a file has no extracted text', async () => {
		vi.mocked(getFileById).mockResolvedValueOnce({ id: 'f1', data: { content: '' } });
		renderPage();
		fireEvent.click(await screen.findByRole('button', { name: 'Open file1.txt' }));
		expect(await screen.findByText('No text was extracted from this file.')).toBeInTheDocument();
	});
});

describe('KnowledgeBasePage add-content dialogs (#1096)', () => {
	const choose = async (item: string) => {
		renderPage();
		await screen.findByText('file1.txt');
		openMenu('Add content');
		fireEvent.click(await screen.findByText(item));
	};

	it('titles the web page dialog after its menu item, with Cancel and Add web page', async () => {
		await choose('Add a web page');
		expect(await screen.findByRole('dialog', { name: 'Add a web page' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Add web page' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
	});

	it('adds text as a .txt file, refusing empty fields under them', async () => {
		await choose('Add text');
		await screen.findByRole('dialog', { name: 'Add text' });
		fireEvent.change(screen.getByLabelText('Title'), { target: { value: ' ' } });
		fireEvent.click(screen.getByRole('button', { name: 'Add text' }));
		expect(await screen.findByText('Give the text a title.')).toBeInTheDocument();
		expect(screen.getByText('Write or paste the text to add.')).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Notes' } });
		fireEvent.change(screen.getByLabelText('Text'), { target: { value: 'hello' } });
		fireEvent.click(screen.getByRole('button', { name: 'Add text' }));
		await waitFor(() => expect(vi.mocked(uploadFile).mock.calls.at(-1)?.[1].name).toBe('Notes.txt'));
	});

	it('creates a folder, naming it in the toast, and refuses an empty name', async () => {
		vi.mocked(createKnowledgeDirectory).mockResolvedValue({ id: 'd2' });
		const success = vi.spyOn(toast, 'success');
		await choose('New folder');
		await screen.findByRole('dialog', { name: 'New folder' });
		fireEvent.click(screen.getByRole('button', { name: 'Create folder' }));
		expect(await screen.findByText('Give the folder a name.')).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Papers' } });
		fireEvent.click(screen.getByRole('button', { name: 'Create folder' }));
		await waitFor(() => expect(createKnowledgeDirectory).toHaveBeenCalledWith('t', 'kb1', 'Papers', null));
		await waitFor(() => expect(success).toHaveBeenCalledWith('Created the folder "Papers"'));
	});
});

describe('knowledgeToasts', () => {
	it('reads the server words from a detail, a message, a string or anything else', async () => {
		const { errorText } = await import('./knowledgeToasts');
		expect(errorText({ detail: 'd' })).toBe('d');
		expect(errorText(new Error('m'))).toBe('m');
		expect(errorText(' s ')).toBe('s');
		expect(errorText(42)).toBe('42');
		expect(errorText('')).toBeNull();
		expect(errorText(undefined)).toBeNull();
	});
});
