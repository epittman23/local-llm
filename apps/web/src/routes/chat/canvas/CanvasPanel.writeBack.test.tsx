import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatFile, Message } from '@/lib/chat/history';
import { CanvasContext } from './CanvasContext';
import { CanvasPanel } from './CanvasPanel';
import { id, output, renderWithRouter, upload } from './testing';
import { useCanvas } from './useCanvas';

const api = vi.hoisted(() => ({
	text: vi.fn(),
	list: vi.fn(),
	create: vi.fn(),
	write: vi.fn(),
	file: vi.fn()
}));
vi.mock('@/lib/apis/sandbox', () => ({
	getSandboxOutputHtml: vi.fn(),
	getSandboxOutputText: api.text,
	writeBackOutput: api.write
}));
vi.mock('@/lib/apis/files/versions', () => ({ listFileVersions: api.list, createFileVersion: api.create }));
vi.mock('@/lib/apis/files', () => ({ getFileById: api.file }));
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
const reply = (files: ChatFile[], role: Message['role'] = 'assistant'): Message[] => [
	{ id: 'm1', parentId: null, childrenIds: [], role, content: '', done: true, files }
];

function Harness({
	files,
	generating = false,
	editable = true,
	ownChat = true,
	role = 'assistant'
}: {
	ownChat?: boolean;
	role?: Message['role'];
	files: ChatFile[];
	generating?: boolean;
	editable?: boolean;
}) {
	const canvas = useCanvas(reply(files, role), false);
	return (
		<CanvasContext.Provider
			value={{ openId: canvas.openId, open: canvas.open, attach: () => true, generating, ownChat }}
		>
			<CanvasPanel canvas={canvas} editable={editable} />
		</CanvasContext.Provider>
	);
}

const show = (
	opts: {
		files?: ChatFile[];
		open?: string;
		generating?: boolean;
		editable?: boolean;
		ownChat?: boolean;
		role?: Message['role'];
	} = {}
) =>
	renderWithRouter(
		<Harness
			files={opts.files ?? [output('1', 'fit.py')]}
			generating={opts.generating}
			editable={opts.editable}
			ownChat={opts.ownChat}
			role={opts.role}
		/>,
		[`/c/x?canvas=${opts.open ?? FIT}`]
	);

async function openMenu(name: string) {
	fireEvent.pointerDown(await screen.findByRole('button', { name }), { button: 0, pointerType: 'mouse' });
	return screen.findByRole('menu');
}
const item = (menu: HTMLElement) => within(menu).queryByRole('menuitem', { name: 'Save to workspace' });
const settled = () => screen.findByRole('button', { name: 'Edit document' });

beforeEach(() => {
	for (const mock of [
		api.text,
		api.list,
		api.create,
		api.write,
		api.file,
		vi.mocked(toast.success),
		vi.mocked(toast.error)
	])
		mock.mockReset();
	api.text.mockResolvedValue({ text: 'x = 1\n', truncated: false });
	api.list.mockImplementation(async (_t, file) => [entry(file, 1)]);
	api.file.mockResolvedValue({ data: { status: 'completed' } });
	api.write.mockResolvedValue({ status: 'written', path: 'outputs/fit.py', bytes: 6 });
});
afterEach(cleanup);

describe('Save to workspace', () => {
	it('is in the Copy menu of a sandbox output and writes the file shown, once', async () => {
		show();
		await settled();
		fireEvent.click(item(await openMenu('Copy')) as HTMLElement);
		await waitFor(() => expect(toast.success).toHaveBeenCalled());
		expect(api.write).toHaveBeenCalledTimes(1);
		expect(api.write).toHaveBeenCalledWith('', FIT, false);
		expect(toast.success).toHaveBeenCalledWith(
			'Saved to the workspace. The model sees it the next time it reads the file.'
		);
	});

	it('writes the saved version that is shown, not the original', async () => {
		api.list.mockResolvedValue([entry(FIT, 1), entry(V2, 2)]);
		show();
		await screen.findByRole('button', { name: 'Version 2 of 2' });
		fireEvent.click(item(await openMenu('Copy')) as HTMLElement);
		await waitFor(() => expect(api.write).toHaveBeenCalledWith('', V2, false));
	});

	it.each([
		['an upload', () => ({ files: [upload('1', 'fit.py')], role: 'user' as const })],
		['a temporary chat', () => ({ editable: false })],
		['a chat that is not the signed-in user’s own (an admin reading it)', () => ({ ownChat: false })],
		['a reply being written', () => ({ generating: true })]
	])('is not offered for %s', async (_name, opts) => {
		show(opts());
		await screen.findByRole('button', { name: 'Copy' });
		await waitFor(() => expect(api.text).toHaveBeenCalled());
		expect(item(await openMenu('Copy'))).toBeNull();
	});

	it('is not offered for a page that is too large to edit or a document that is an image', async () => {
		show({ files: [output('1', 'pic.png')] });
		await waitFor(() => expect(screen.getAllByRole('heading').length).toBeGreaterThan(0));
		expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
	});

	it('asks when the file changed, and Replace repeats with force', async () => {
		api.write
			.mockResolvedValueOnce({ status: 'changed', missing: false })
			.mockResolvedValueOnce({ status: 'written', path: 'outputs/fit.py', bytes: 6 });
		show();
		await settled();
		fireEvent.click(item(await openMenu('Copy')) as HTMLElement);
		expect(await screen.findByRole('alertdialog')).toHaveTextContent('Replace the workspace file?');
		fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
		await waitFor(() => expect(api.write).toHaveBeenLastCalledWith('', FIT, true));
		await waitFor(() => expect(toast.success).toHaveBeenCalled());
	});

	it('offers Save to workspace beside Attach to next message after a save', async () => {
		api.create.mockResolvedValue({ id: V2, filename: 'fit.py', data: {}, meta: { version: 2, size: 6 } });
		show();
		fireEvent.click(await settled());
		fireEvent.change(await screen.findByRole('textbox', { name: 'Edit fit.py' }), { target: { value: 'x = 2\n' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save document' }));
		await waitFor(() => expect(toast.success).toHaveBeenCalled());
		const options = vi.mocked(toast.success).mock.calls[0][1] as unknown as {
			action: { label: string };
			cancel: { label: string; onClick: () => void };
		};
		expect(options.action.label).toBe('Attach to next message');
		expect(options.cancel.label).toBe('Save to workspace');
		options.cancel.onClick();
		await waitFor(() => expect(api.write).toHaveBeenCalledWith('', V2, false));
	});

	it('has no toast action to save to the workspace while a reply is written', async () => {
		api.create.mockResolvedValue({ id: V2, filename: 'fit.py', data: {}, meta: { version: 2, size: 6 } });
		show({ generating: true });
		fireEvent.click(await settled());
		fireEvent.change(await screen.findByRole('textbox', { name: 'Edit fit.py' }), { target: { value: 'x = 2\n' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save document' }));
		await waitFor(() => expect(toast.success).toHaveBeenCalled());
		expect((vi.mocked(toast.success).mock.calls[0][1] as { cancel?: unknown }).cancel).toBeUndefined();
	});
});

it('has no toast action to save to the workspace in a chat the user does not own', async () => {
	api.create.mockResolvedValue({ id: V2, filename: 'fit.py', data: {}, meta: { version: 2, size: 6 } });
	show({ ownChat: false });
	fireEvent.click(await settled());
	fireEvent.change(await screen.findByRole('textbox', { name: 'Edit fit.py' }), { target: { value: 'x = 2\n' } });
	fireEvent.click(screen.getByRole('button', { name: 'Save document' }));
	await waitFor(() => expect(toast.success).toHaveBeenCalled());
	expect((vi.mocked(toast.success).mock.calls[0][1] as { cancel?: unknown }).cancel).toBeUndefined();
});
