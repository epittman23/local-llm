import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatFile, Message } from '@/lib/chat/history';
import { CanvasContext } from './CanvasContext';
import { CanvasPanel } from './CanvasPanel';
import { id, output, renderWithRouter } from './testing';
import { useCanvas } from './useCanvas';

const api = vi.hoisted(() => ({
	text: vi.fn<(token: string, id: string, max: number) => Promise<{ text: string; truncated: boolean }>>(),
	list: vi.fn()
}));
vi.mock('@/lib/apis/sandbox', () => ({ getSandboxOutputHtml: vi.fn(), getSandboxOutputText: api.text }));
vi.mock('@/lib/apis/files/versions', () => ({ listFileVersions: api.list, createFileVersion: vi.fn() }));
vi.mock('@/lib/apis/files', () => ({ getFileById: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const FIT = id('1');
const V2 = id('a');
const entry = (file: string, version: number) => ({
	id: file,
	version,
	size: 6,
	created_at: 1_700_000_000,
	name: 'fit.py'
});

const reply = (files: ChatFile[]): Message[] => [
	{ id: 'm1', parentId: null, childrenIds: [], role: 'assistant', content: '', done: true, files }
];

function Harness({ files }: { files: ChatFile[] }) {
	const canvas = useCanvas(reply(files), false);
	return (
		<CanvasContext.Provider value={{ openId: canvas.openId, open: canvas.open }}>
			<CanvasPanel canvas={canvas} />
		</CanvasContext.Provider>
	);
}

const show = (files: ChatFile[], open: string) => renderWithRouter(<Harness files={files} />, [`/c/x?canvas=${open}`]);
const changesButton = () => screen.findByRole('button', { name: 'Changes' });
const ask = () => screen.findByRole('alertdialog');

beforeAll(() => {
	// Radix Select measures and captures the pointer, which the test DOM does not do.
	Element.prototype.scrollIntoView = vi.fn();
	Element.prototype.hasPointerCapture = vi.fn(() => false);
	Element.prototype.releasePointerCapture = vi.fn();
});

beforeEach(() => {
	api.text.mockReset();
	api.list.mockReset();
	api.text.mockImplementation(async (_t, file) => ({
		text: file === V2 ? 'x = 2\ny = 1\n' : 'x = 1\n',
		truncated: false
	}));
	api.list.mockImplementation(async (_t, file) => [entry(FIT, 1), entry(V2, 2)].slice(0, file === FIT ? 2 : 2));
});
afterEach(cleanup);

describe('the Changes view in the canvas', () => {
	it('is a third segment with two or more versions, and compares the latest with the one before it', async () => {
		show([output('1', 'fit.py')], FIT);
		fireEvent.click(await changesButton());
		expect(await screen.findByRole('region', { name: 'Changes from version 1 to version 2' })).toHaveTextContent(
			'Added: y = 1'
		);
		expect(screen.getByRole('button', { name: 'Changes' })).toHaveAttribute('aria-pressed', 'true');
		expect(screen.getByRole('button', { name: 'Source' })).toHaveAttribute('aria-pressed', 'false');
		// Read-only: the Edit button is gone, and Source brings it back.
		expect(screen.queryByRole('button', { name: 'Edit document' })).toBeNull();
		fireEvent.click(screen.getByRole('button', { name: 'Source' }));
		expect(await screen.findByRole('button', { name: 'Edit document' })).toBeInTheDocument();
		await waitFor(() => expect(document.querySelector('.code-surface')).toHaveTextContent('y = 1'));
	});

	it('is not offered with one version', async () => {
		api.list.mockResolvedValue([entry(FIT, 1)]);
		show([output('1', 'fit.py')], FIT);
		await screen.findByRole('button', { name: 'Edit document' });
		expect(screen.queryByRole('button', { name: 'Changes' })).toBeNull();
	});

	it('is not offered for an image or a PDF, however many versions the server lists', async () => {
		for (const name of ['plot.png', 'paper.pdf']) {
			api.list.mockResolvedValue([entry(FIT, 1), entry(V2, 2)]);
			const { unmount } = show([output('1', name)], FIT);
			await screen.findByRole('heading', { level: 2 });
			expect(screen.queryByRole('button', { name: 'Changes' }), name).toBeNull();
			unmount();
		}
	});

	it('asks before it leaves a draft behind, and goes on once the draft is discarded', async () => {
		show([output('1', 'fit.py')], FIT);
		fireEvent.click(await screen.findByRole('button', { name: 'Edit document' }));
		const box = await screen.findByRole('textbox', { name: 'Edit fit.py' });
		fireEvent.change(box, { target: { value: 'x = 9\n' } });
		fireEvent.click(await changesButton());
		fireEvent.click(within(await ask()).getByRole('button', { name: 'Keep editing' }));
		expect(await screen.findByRole('textbox', { name: 'Edit fit.py' })).toHaveValue('x = 9\n');
		expect(screen.queryByRole('region', { name: /^Changes from/ })).toBeNull();

		fireEvent.click(screen.getByRole('button', { name: 'Changes' }));
		fireEvent.click(within(await ask()).getByRole('button', { name: 'Discard changes' }));
		expect(await screen.findByRole('region', { name: 'Changes from version 1 to version 2' })).toBeInTheDocument();
		expect(screen.queryByRole('textbox')).toBeNull();
	});
});
