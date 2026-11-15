import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { uploadFile } from '@/lib/apis/files';
import { searchKnowledgeBases, searchKnowledgeFiles } from '@/lib/apis/knowledge';
import { searchNotes } from '@/lib/apis/notes';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { KnowledgePicker } from './KnowledgePicker';
import type { KnowledgeItem } from './modelEditorLogic';

vi.mock('@/lib/apis/knowledge', () => ({ searchKnowledgeBases: vi.fn(), searchKnowledgeFiles: vi.fn() }));
vi.mock('@/lib/apis/notes', () => ({ searchNotes: vi.fn() }));
vi.mock('@/lib/apis/files', () => ({ uploadFile: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

const renderPicker = (items: KnowledgeItem[] = [], onChange = vi.fn(), error?: string) => {
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<TooltipProvider>
				<MemoryRouter>
					<KnowledgePicker items={items} onChange={onChange} error={error} />
				</MemoryRouter>
			</TooltipProvider>
		</QueryClientProvider>
	);
	return onChange;
};

const upload = (file: File) => {
	const input = document.querySelector('input[type="file"]') as HTMLInputElement;
	fireEvent.change(input, { target: { files: [file] } });
};

describe('KnowledgePicker', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useAuthStore.setState({ token: 'jwt', user: { id: 'u1', role: 'admin' } } as never);
		useConfigStore.setState({ config: { name: 'x', version: '1', file: { max_size: 1 } } });
		vi.mocked(searchNotes).mockResolvedValue({
			items: [
				{ id: 'n1', title: 'Lecture notes' },
				{ id: 'n2', title: 'Exam plan' }
			]
		} as never);
		vi.mocked(searchKnowledgeFiles).mockResolvedValue({ items: [{ id: 'f1', filename: 'syllabus.pdf' }] } as never);
		vi.mocked(searchKnowledgeBases).mockResolvedValue({
			items: [{ id: 'k1', name: 'Handbook', file_count: 12 }]
		} as never);
	});

	it('groups the choices, knowledge bases first, then files, then notes, with each base’s size (#1014)', async () => {
		renderPicker();
		fireEvent.click(await screen.findByRole('button', { name: 'Choose knowledge' }));
		const dialog = screen.getByRole('dialog', { name: 'Attach knowledge' });
		await within(dialog).findByText('Handbook');
		const headings = [...dialog.querySelectorAll('[cmdk-group-heading]')].map((h) => h.textContent);
		expect(headings).toEqual(['Knowledge bases', 'Files', 'Notes']);
		expect(within(dialog).getByText('12 files')).toBeInTheDocument();
	});

	it('attaches the knowledge base that is picked', async () => {
		const onChange = renderPicker();
		fireEvent.click(await screen.findByRole('button', { name: 'Choose knowledge' }));
		fireEvent.click(await screen.findByRole('option', { name: /Handbook/ }));
		expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ id: 'k1', type: 'collection' })]);
	});

	it('says what was searched when nothing matches', async () => {
		renderPicker();
		fireEvent.click(await screen.findByRole('button', { name: 'Choose knowledge' }));
		await screen.findByText('Handbook');
		vi.mocked(searchKnowledgeBases).mockResolvedValue({ items: [] } as never);
		vi.mocked(searchKnowledgeFiles).mockResolvedValue({ items: [] } as never);
		vi.mocked(searchNotes).mockResolvedValue({ items: [] } as never);
		fireEvent.change(screen.getByPlaceholderText('Search knowledge'), { target: { value: 'zzz' } });
		expect(await screen.findByText('Nothing matches “zzz”.', {}, { timeout: 2000 })).toBeInTheDocument();
	});

	it('with nothing to attach, says where to make some instead of offering an empty list (#956)', async () => {
		vi.mocked(searchKnowledgeBases).mockResolvedValue({ items: [] } as never);
		vi.mocked(searchKnowledgeFiles).mockResolvedValue({ items: [] } as never);
		vi.mocked(searchNotes).mockResolvedValue({ items: [] } as never);
		renderPicker();
		expect(await screen.findByRole('link', { name: 'Create one in Knowledge' })).toHaveAttribute(
			'href',
			'/workspace/knowledge'
		);
		expect(screen.queryByRole('button', { name: 'Choose knowledge' })).toBeNull();
	});

	it('names each chip’s buttons by what they do, and the file dialog’s switch by its setting (FRM-5)', async () => {
		const onChange = renderPicker([
			{ id: 'k1', name: 'Handbook', type: 'collection' },
			{ id: 'f1', name: 'syllabus.pdf', type: 'file' }
		]);
		expect(screen.getByRole('button', { name: 'Details of Handbook' })).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Remove Handbook' }));
		expect(onChange).toHaveBeenLastCalledWith([{ id: 'f1', name: 'syllabus.pdf', type: 'file' }]);
		fireEvent.click(screen.getByRole('button', { name: 'Remove all' }));
		expect(onChange).toHaveBeenLastCalledWith([]);
		fireEvent.click(screen.getByRole('button', { name: 'Edit syllabus.pdf' }));
		const whole = await screen.findByRole('switch', { name: 'Use the whole document' });
		fireEvent.click(whole);
		expect(onChange).toHaveBeenLastCalledWith([
			{ id: 'k1', name: 'Handbook', type: 'collection' },
			{ id: 'f1', name: 'syllabus.pdf', type: 'file', context: 'full' }
		]);
	});

	it('shows an error passed to it, announced', () => {
		renderPicker([], vi.fn(), 'Wait for the files to finish uploading, then save.');
		expect(screen.getByRole('alert')).toHaveTextContent('Wait for the files to finish uploading, then save.');
	});

	it('refuses an empty file, one over the limit and an image, naming the file (#1095)', () => {
		renderPicker();
		upload(new File([], 'empty.txt'));
		expect(toast.error).toHaveBeenLastCalledWith("“empty.txt” is empty, so it wasn't added.");
		upload(new File([new Uint8Array(2 * 1024 * 1024)], 'big.pdf'));
		expect(toast.error).toHaveBeenLastCalledWith("“big.pdf” is larger than the 1 MB limit, so it wasn't added.");
		upload(new File(['x'], 'pic.png', { type: 'image/png' }));
		expect(toast.error).toHaveBeenLastCalledWith(
			'“pic.png” is an image. Knowledge takes documents; attach images in a chat.'
		);
		expect(uploadFile).not.toHaveBeenCalled();
	});

	it('shows an upload while it runs, then the uploaded file', async () => {
		vi.mocked(uploadFile).mockResolvedValue({ id: 'up1', meta: { collection_name: 'c1' } } as never);
		const onChange = renderPicker();
		upload(new File(['x'], 'notes.md'));
		expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ name: 'notes.md', status: 'uploading' })]);
		await waitFor(() =>
			expect(onChange).toHaveBeenLastCalledWith([
				expect.objectContaining({ name: 'notes.md', status: 'uploaded', id: 'up1', collection_name: 'c1' })
			])
		);
	});

	it('says which upload failed and why, in words, and drops its row', async () => {
		vi.mocked(uploadFile).mockRejectedValue('Disk full');
		const onChange = renderPicker();
		upload(new File(['x'], 'notes.md'));
		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith("Couldn't upload “notes.md”. The server answered with an error.", {
				description: 'Disk full'
			})
		);
		expect(onChange).toHaveBeenLastCalledWith([]);
	});
});
