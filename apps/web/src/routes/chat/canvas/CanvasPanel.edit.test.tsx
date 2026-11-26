import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatFile, Message } from '@/lib/chat/history';
import { withHtmlPolicy } from '@/lib/chat/htmlPolicy';
import { CanvasContext } from './CanvasContext';
import { CanvasPanel } from './CanvasPanel';
import { blockDoc, docOf, id, output, renderWithRouter, upload } from './testing';
import { type CanvasState, useCanvas } from './useCanvas';

const api = vi.hoisted(() => ({
	text: vi.fn<(token: string, id: string, max: number) => Promise<{ text: string; truncated: boolean }>>(),
	list: vi.fn(),
	create: vi.fn(),
	file: vi.fn()
}));
vi.mock('@/lib/apis/sandbox', () => ({ getSandboxOutputHtml: vi.fn(), getSandboxOutputText: api.text }));
vi.mock('@/lib/apis/files/versions', () => ({ listFileVersions: api.list, createFileVersion: api.create }));
vi.mock('@/lib/apis/files', () => ({ getFileById: api.file }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const FIT = id('1');
const NOTES = id('2');
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

/** The panel on the real canvas state, in the address, so a guarded navigation can be seen to stop or go. */
function Harness({ files, attach }: { files: ChatFile[]; attach?: (file: ChatFile) => boolean }) {
	const canvas = useCanvas(reply(files), false);
	return (
		<CanvasContext.Provider value={{ openId: canvas.openId, open: canvas.open, attach }}>
			<CanvasPanel canvas={canvas} />
		</CanvasContext.Provider>
	);
}

const FILES = [output('1', 'fit.py'), output('2', 'notes.md')];
const show = (opts: { files?: ChatFile[]; open?: string; attach?: (file: ChatFile) => boolean } = {}) =>
	renderWithRouter(<Harness files={opts.files ?? FILES} attach={opts.attach} />, [`/c/x?canvas=${opts.open ?? FIT}`]);

const textbox = () => screen.findByRole('textbox', { name: 'Edit fit.py' }) as Promise<HTMLTextAreaElement>;
const editFit = async () => {
	fireEvent.click(await screen.findByRole('button', { name: 'Edit document' }));
	return textbox();
};
const type = (box: HTMLElement, value: string) => fireEvent.change(box, { target: { value } });
const code = (text: string) => waitFor(() => expect(document.querySelector('.code-surface')).toHaveTextContent(text));
const ask = () => screen.findByRole('alertdialog');
const heading = () => screen.getByRole('heading', { level: 2 });
async function openMenu(name: string | RegExp) {
	fireEvent.pointerDown(await screen.findByRole('button', { name }), { button: 0, pointerType: 'mouse' });
	return screen.findByRole('menu');
}
const beforeUnload = () => {
	const event = new Event('beforeunload', { cancelable: true });
	window.dispatchEvent(event);
	return event.defaultPrevented;
};

beforeEach(() => {
	for (const mock of [api.text, api.list, api.create, api.file, vi.mocked(toast.success), vi.mocked(toast.error)])
		mock.mockReset();
	api.text.mockImplementation(async (_t, file) => ({
		text: file === V2 ? 'x = 2\n' : file === NOTES ? '# Notes\n' : 'x = 1\n',
		truncated: false
	}));
	let saved = false;
	api.list.mockImplementation(async (_t, file) => (saved ? [entry(FIT, 1), entry(V2, 2)] : [entry(file, 1)]));
	api.create.mockImplementation(async () => {
		saved = true;
		return { id: V2, filename: 'fit.py', data: {}, meta: { version: 2, size: 6 } };
	});
	api.file.mockResolvedValue({ data: { status: 'completed' } });
});
afterEach(cleanup);

describe('editing a document', () => {
	it('shows the editor with focus in it, and the SaveBar says Unsaved changes only after a change', async () => {
		show();
		const box = await editFit();
		expect(box).toHaveValue('x = 1\n');
		await waitFor(() => expect(box).toHaveFocus());
		expect(screen.getByRole('status', { name: '' })).toHaveTextContent('All changes saved');
		expect(screen.getByRole('button', { name: 'Save document' })).toBeDisabled();
		type(box, 'x = 11\n');
		expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Save document' })).toBeEnabled();
		// Typing the baseline back is no change (FRM-3).
		type(box, 'x = 1\n');
		expect(screen.queryByText('Unsaved changes')).toBeNull();
	});

	it('Discard changes restores the text and moves focus to the heading', async () => {
		show();
		const box = await editFit();
		type(box, 'changed');
		fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
		expect(screen.queryByRole('textbox')).toBeNull();
		expect(screen.queryByRole('button', { name: 'Save document' })).toBeNull();
		expect(heading()).toHaveFocus();
		await code('x = 1');
		expect(await screen.findByRole('button', { name: 'Edit document' })).toBeInTheDocument();
	});

	it('Save document posts once, shows Version 2 of 2 and offers Attach to next message', async () => {
		const attach = vi.fn(() => true);
		show({ attach });
		const box = await editFit();
		type(box, 'x = 2\n');
		fireEvent.click(screen.getByRole('button', { name: 'Save document' }));
		await waitFor(() => expect(toast.success).toHaveBeenCalled());
		expect(api.create).toHaveBeenCalledTimes(1);
		expect(api.create).toHaveBeenCalledWith('', FIT, 'x = 2\n');
		expect(toast.success).toHaveBeenCalledWith(
			'Saved as version 2',
			expect.objectContaining({ action: expect.objectContaining({ label: 'Attach to next message' }) })
		);
		// The editor is gone, the heading counts the versions and holds focus, and the new text is shown at once.
		expect(screen.queryByRole('textbox')).toBeNull();
		expect(await screen.findByRole('button', { name: 'Version 2 of 2' })).toBeInTheDocument();
		expect(heading()).toHaveTextContent(/^fit\.py Python$/);
		expect(heading()).toHaveFocus();
		await code('x = 2');
		expect(api.text).not.toHaveBeenCalledWith('', V2, expect.anything(), expect.anything());
		// The toast's action attaches that version, whole.
		const action = vi.mocked(toast.success).mock.calls[0][1] as unknown as { action: { onClick: () => void } };
		action.action.onClick();
		await waitFor(() => expect(attach).toHaveBeenCalledTimes(1));
		expect(attach).toHaveBeenCalledWith(
			expect.objectContaining({ id: V2, type: 'file', context: 'full', name: 'fit.py' })
		);
	});

	it('Ctrl+S in the editor saves', async () => {
		show();
		const box = await editFit();
		type(box, 'x = 3\n');
		fireEvent.keyDown(box, { key: 's', ctrlKey: true });
		await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1));
	});

	it('keeps the editor and the draft when saving fails, and says so', async () => {
		api.create.mockRejectedValueOnce({ detail: 'Not found' });
		show();
		const box = await editFit();
		type(box, 'x = 5\n');
		fireEvent.click(screen.getByRole('button', { name: 'Save document' }));
		await waitFor(() => expect(toast.error).toHaveBeenCalled());
		expect(await textbox()).toHaveValue('x = 5\n');
		expect(screen.getByRole('button', { name: 'Save document' })).toBeEnabled();
	});

	it('cannot save an empty document, and says why', async () => {
		show();
		const box = await editFit();
		type(box, '');
		expect(screen.getByRole('button', { name: 'Save document' })).toBeDisabled();
		expect(screen.getByText('A document can’t be saved empty')).toBeInTheDocument();
	});
});

describe('the guard on unsaved edits', () => {
	const dirty = async () => {
		const result = show();
		type(await editFit(), 'x = 9\n');
		return result;
	};
	const hasCanvas = (router: { state: { location: { search: string } } }) =>
		router.state.location.search.includes('canvas=');

	it('asks before Close, keeps the draft and the focus on Keep editing, and closes on Discard changes', async () => {
		const { router } = await dirty();
		fireEvent.click(screen.getByRole('button', { name: 'Close canvas' }));
		const dialog = await ask();
		expect(dialog).toHaveTextContent('Your edits to this document are not saved.');
		fireEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
		await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
		expect(await textbox()).toHaveValue('x = 9\n');
		// NAV-4: focus is back in the editor, not on the Close button that raised the question.
		await waitFor(() => expect(screen.getByRole('textbox', { name: 'Edit fit.py' })).toHaveFocus());
		expect(hasCanvas(router)).toBe(true);
		fireEvent.click(screen.getByRole('button', { name: 'Close canvas' }));
		fireEvent.click(within(await ask()).getByRole('button', { name: 'Discard changes' }));
		await waitFor(() => expect(hasCanvas(router)).toBe(false));
	});

	it('asks before Escape on the panel closes it', async () => {
		await dirty();
		fireEvent.keyDown(heading(), { key: 'Escape' });
		expect(await ask()).toBeInTheDocument();
	});

	it('asks before another document opens', async () => {
		const { router } = await dirty();
		fireEvent.click(within(await openMenu('2 documents in this chat')).getByRole('menuitem', { name: 'notes.md' }));
		fireEvent.click(within(await ask()).getByRole('button', { name: 'Keep editing' }));
		await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
		expect(router.state.location.search).toBe(`?canvas=${FIT}`);
		expect(await textbox()).toHaveValue('x = 9\n');
		fireEvent.click(within(await openMenu('2 documents in this chat')).getByRole('menuitem', { name: 'notes.md' }));
		fireEvent.click(within(await ask()).getByRole('button', { name: 'Discard changes' }));
		await waitFor(() => expect(router.state.location.search).toBe(`?canvas=${NOTES}`));
		expect(screen.queryByRole('textbox')).toBeNull();
	});

	it('asks before leaving the chat, and cancels a reload or a closed tab', async () => {
		const { router } = await dirty();
		expect(beforeUnload()).toBe(true);
		act(() => {
			void router.navigate('/');
		});
		expect(await ask()).toBeInTheDocument();
		expect(router.state.location.pathname).toBe('/c/x');
	});

	it('does not ask of a clean editor, or without one, and a reload is not cancelled', async () => {
		const { router } = show();
		expect(beforeUnload()).toBe(false);
		fireEvent.click(await screen.findByRole('button', { name: 'Edit document' }));
		await textbox();
		expect(beforeUnload()).toBe(false);
		fireEvent.click(screen.getByRole('button', { name: 'Close canvas' }));
		await waitFor(() => expect(hasCanvas(router)).toBe(false));
		expect(screen.queryByRole('alertdialog')).toBeNull();
	});

	it('Escape inside the editor, once typed, does not close the canvas', async () => {
		const { router } = await dirty();
		fireEvent.keyDown(await textbox(), { key: 'Escape' });
		expect(screen.queryByRole('alertdialog')).toBeNull();
		expect(hasCanvas(router)).toBe(true);
		expect(await textbox()).toHaveValue('x = 9\n');
	});

	it('asks before the Preview switch leaves a draft of a Markdown file', async () => {
		show({ open: NOTES });
		fireEvent.click(await screen.findByRole('button', { name: 'Edit document' }));
		const box = (await screen.findByRole('textbox', { name: 'Edit notes.md' })) as HTMLTextAreaElement;
		expect(screen.getByRole('button', { name: 'Source' })).toHaveAttribute('aria-pressed', 'true');
		type(box, '# Changed\n');
		fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
		fireEvent.click(within(await ask()).getByRole('button', { name: 'Discard changes' }));
		await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
		expect(screen.getByRole('button', { name: 'Preview' })).toHaveAttribute('aria-pressed', 'true');
	});

	it('asks before another version is shown', async () => {
		api.list.mockResolvedValue([entry(FIT, 1), entry(V2, 2)]);
		show();
		type(await editFit(), 'x = 9\n');
		fireEvent.click(
			within(await openMenu('Version 2 of 2')).getByRole('menuitemradio', { name: 'Version 1 (original)' })
		);
		expect(await ask()).toBeInTheDocument();
	});
});

describe('which documents can be edited', () => {
	const renderStatic = (doc: ReturnType<typeof docOf>) => {
		const canvas: CanvasState = {
			documents: [doc],
			openId: doc.id,
			doc,
			gone: false,
			open: vi.fn(),
			close: vi.fn()
		};
		return renderWithRouter(<CanvasPanel canvas={canvas} />);
	};

	it('offers no Edit for a Python block, a table or an image', async () => {
		for (const doc of [blockDoc('x = 1', 'python'), docOf(output('4', 'table.csv')), docOf(output('5', 'plot.png'))]) {
			renderStatic(doc);
			await screen.findByRole('complementary');
			expect(screen.queryByRole('button', { name: 'Edit document' })).toBeNull();
			cleanup();
		}
		expect(api.list).not.toHaveBeenCalled();
	});

	it('offers no Edit in a temporary chat', async () => {
		const doc = docOf(output('1', 'fit.py'));
		const canvas: CanvasState = { documents: [doc], openId: doc.id, doc, gone: false, open: vi.fn(), close: vi.fn() };
		renderWithRouter(<CanvasPanel canvas={canvas} editable={false} />);
		await code('x = 1');
		expect(screen.queryByRole('button', { name: 'Edit document' })).toBeNull();
	});

	it('offers no Edit for a file cut at the cap, and says it can only be downloaded', async () => {
		api.text.mockResolvedValue({ text: 'x = 1\n', truncated: true });
		show();
		expect(await screen.findByText(/Showing the first 256 KiB/)).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Edit document' })).toBeNull();
	});

	it('offers no Edit for text that is not UTF-8, and says to download it', async () => {
		api.text.mockResolvedValue({ text: 'caf�', truncated: false });
		show();
		expect(await screen.findByText('This file is not UTF-8 text; download it to change it.')).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Edit document' })).toBeNull();
	});

	it('edits an uploaded file too', async () => {
		renderStatic(docOf(upload('7', 'notes.md'), 'user'));
		expect(await screen.findByRole('button', { name: 'Edit document' })).toBeInTheDocument();
	});

	it('keeps the viewer working when the versions cannot be listed', async () => {
		api.list.mockRejectedValue({ detail: 'down' });
		show();
		await code('x = 1');
		expect(await screen.findByRole('button', { name: 'Edit document' })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /^Version \d of \d$/ })).toBeNull();
		expect(heading()).not.toHaveTextContent('Version');
	});
});

describe('versions', () => {
	beforeEach(() => api.list.mockResolvedValue([entry(FIT, 1), entry(V2, 2)]));

	it('counts them on the Versions menu, shows an older one read-only with the way back, and edits only the latest', async () => {
		show();
		expect(await screen.findByRole('button', { name: 'Version 2 of 2' })).toBeInTheDocument();
		expect(heading()).toHaveTextContent(/^fit\.py Python$/);
		await code('x = 2');
		expect(await screen.findByRole('button', { name: 'Edit document' })).toBeInTheDocument();
		const menu = await openMenu('Version 2 of 2');
		expect(within(menu).getByRole('menuitemradio', { name: /^Version 2, / })).toBeChecked();
		fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'Version 1 (original)' }));
		expect(await screen.findByText('You are viewing version 1 of 2.')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Version 1 of 2' })).toBeInTheDocument();
		await code('x = 1');
		expect(screen.queryByRole('button', { name: 'Edit document' })).toBeNull();
		fireEvent.click(screen.getByRole('button', { name: 'Back to version 2' }));
		expect(await screen.findByRole('button', { name: 'Version 2 of 2' })).toBeInTheDocument();
		expect(screen.queryByText(/You are viewing/)).toBeNull();
		expect(await screen.findByRole('button', { name: 'Edit document' })).toBeInTheDocument();
	});

	it('attaches the version shown to the next message, whole', async () => {
		const attach = vi.fn(() => true);
		show({ attach });
		await code('x = 2');
		fireEvent.click(within(await openMenu('Copy')).getByRole('menuitem', { name: 'Attach to next message' }));
		await waitFor(() => expect(attach).toHaveBeenCalledTimes(1));
		expect(attach).toHaveBeenCalledWith({
			type: 'file',
			id: V2,
			name: 'fit.py',
			url: V2,
			size: 6,
			content_type: 'text/plain',
			collection_name: '',
			context: 'full'
		});
		expect(toast.success).toHaveBeenCalledWith('Attached version 2');
	});

	it('refuses to attach a version the server could not prepare for the model', async () => {
		api.file.mockResolvedValue({ data: { status: 'failed' } });
		const attach = vi.fn(() => true);
		show({ attach });
		await code('x = 2');
		fireEvent.click(within(await openMenu('Copy')).getByRole('menuitem', { name: 'Attach to next message' }));
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith('This version could not be prepared for the model'));
		expect(attach).not.toHaveBeenCalled();
	});

	it('does not say Attached when the chat refused the file', async () => {
		const attach = vi.fn(() => false);
		show({ attach });
		await code('x = 2');
		fireEvent.click(within(await openMenu('Copy')).getByRole('menuitem', { name: 'Attach to next message' }));
		await waitFor(() => expect(attach).toHaveBeenCalled());
		expect(toast.success).not.toHaveBeenCalled();
	});

	it('offers no Attach outside a chat that can take it', async () => {
		show();
		await code('x = 2');
		expect(within(await openMenu('Copy')).queryByRole('menuitem', { name: 'Attach to next message' })).toBeNull();
	});

	it('closes the sheet below md after an attach, so the composer shows, but not an open canvas column', async () => {
		const stub = (mdUp: boolean) =>
			vi.stubGlobal(
				'matchMedia',
				vi.fn((query: string) => ({
					matches: query === '(min-width: 768px)' ? mdUp : true,
					addEventListener: vi.fn(),
					removeEventListener: vi.fn()
				}))
			);
		const attach = vi.fn(() => true);
		stub(false);
		const { router } = show({ attach });
		await code('x = 2');
		fireEvent.click(within(await openMenu('Copy')).getByRole('menuitem', { name: 'Attach to next message' }));
		await waitFor(() => expect(router.state.location.search).toBe(''));
		cleanup();
		stub(true);
		const wide = show({ attach });
		await code('x = 2');
		fireEvent.click(within(await openMenu('Copy')).getByRole('menuitem', { name: 'Attach to next message' }));
		await waitFor(() => expect(attach).toHaveBeenCalledTimes(2));
		expect(wide.router.state.location.search).toContain('canvas=');
	});
});

const BLOCK = '<!doctype html><html><body><p>hi</p></body></html>';
/** A reply whose text holds one fenced html block, on the real canvas state, so Close is a guarded navigation. */
function BlockHarness({ code }: { code: string }) {
	const messages: Message[] = [
		{
			id: 'm1',
			parentId: null,
			childrenIds: [],
			role: 'assistant',
			content: `\`\`\`html\n${code}\n\`\`\``,
			done: true
		}
	];
	const canvas = useCanvas(messages, false);
	return <CanvasPanel canvas={canvas} />;
}

describe('editing a page', () => {
	const PAGE = id('3');
	const PAGE_HTML = '<p>hello</p>\n';
	const frameOf = (name: string) => screen.getByTitle(`Preview of ${name}`) as HTMLIFrameElement;
	const showPage = (files: ChatFile[], open: string) => {
		api.text.mockImplementation(async () => ({ text: PAGE_HTML, truncated: false }));
		return show({ files, open });
	};
	const editPage = async () => {
		fireEvent.click(await screen.findByRole('button', { name: 'Edit document' }));
		return screen.findByRole('textbox', { name: 'Edit page.html' }) as Promise<HTMLTextAreaElement>;
	};
	const renderStaticDoc = (doc: ReturnType<typeof blockDoc>) => {
		const canvas: CanvasState = { documents: [doc], openId: doc.id, doc, gone: false, open: vi.fn(), close: vi.fn() };
		return renderWithRouter(<CanvasPanel canvas={canvas} />);
	};
	it('keeps Preview while editing a page the model wrote, and it shows the draft through the policy without leaving edit mode', async () => {
		showPage([output('3', 'page.html')], PAGE);
		const box = await editPage();
		const preview = screen.getByRole('button', { name: 'Preview' });
		expect(preview).toBeEnabled();
		type(box, '<p>changed</p>');
		fireEvent.click(preview);
		// Not a discard: no question, the editor and its SaveBar stay, the draft is intact.
		expect(screen.queryByRole('alertdialog')).toBeNull();
		expect(screen.getByRole('textbox', { name: 'Edit page.html' })).toHaveValue('<p>changed</p>');
		expect(screen.getByRole('button', { name: 'Save document' })).toBeEnabled();
		expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
		expect(preview).toHaveAttribute('aria-pressed', 'true');
		fireEvent.click(screen.getByRole('button', { name: 'Update preview' }));
		const frame = frameOf('page.html');
		expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
		expect(frame.getAttribute('src')).toBeNull();
		expect(frame.getAttribute('srcdoc')).toBe(withHtmlPolicy('<p>changed</p>'));
	});

	it('saves the draft as the text of a new version', async () => {
		showPage([output('3', 'page.html')], PAGE);
		type(await editPage(), '<p>v2</p>');
		fireEvent.click(screen.getByRole('button', { name: 'Save document' }));
		await waitFor(() => expect(api.create).toHaveBeenCalledWith('', PAGE, '<p>v2</p>'));
	});

	it('edits an uploaded page as source only: no Preview, no frame', async () => {
		api.text.mockResolvedValue({ text: PAGE_HTML, truncated: false });
		renderStaticDoc(docOf(upload('4', 'mine.html'), 'user'));
		fireEvent.click(await screen.findByRole('button', { name: 'Edit document' }));
		expect(await screen.findByRole('textbox', { name: 'Edit mine.html' })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Update preview' })).toBeNull();
		expect(document.querySelector('iframe')).toBeNull();
	});

	it('shows a page between 256 KiB and 5 MiB as view only, to be downloaded to change', async () => {
		showPage([output('3', 'page.html', {}, { size: 300 * 1024 })], PAGE);
		expect(await screen.findByText('Too large to edit; download it to change it.')).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Edit document' })).toBeNull();
	});

	it('offers Try changes on a block of HTML: a draft with a Note, no Save, no version, and closing asks', async () => {
		renderWithRouter(<BlockHarness code={BLOCK} />, ['/c/x?canvas=block:m1:0']);
		expect(screen.queryByRole('button', { name: 'Edit document' })).toBeNull();
		fireEvent.click(await screen.findByRole('button', { name: 'Try changes' }));
		const box = (await screen.findByRole('textbox', { name: /^Edit / })) as HTMLTextAreaElement;
		expect(box).toHaveValue(BLOCK);
		expect(screen.getByText('Changes to a code block are not saved. Copy or download them.')).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Save document' })).toBeNull();
		type(box, '<p>mine</p>');
		fireEvent.click(screen.getByRole('button', { name: 'Update preview' }));
		expect((screen.getByTitle(/^Preview of /) as HTMLIFrameElement).getAttribute('srcdoc')).toBe(
			withHtmlPolicy('<p>mine</p>')
		);
		fireEvent.click(screen.getByRole('button', { name: 'Close canvas' }));
		expect(await ask()).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
		fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
		expect(screen.queryByRole('textbox')).toBeNull();
		expect(await screen.findByRole('button', { name: 'Try changes' })).toBeInTheDocument();
		expect(api.create).not.toHaveBeenCalled();
		expect(api.list).not.toHaveBeenCalled();
	});

	it('does not offer Try changes on a block still being written', async () => {
		renderStaticDoc(blockDoc('<p>hi', 'html', false));
		await screen.findByRole('complementary');
		expect(screen.queryByRole('button', { name: 'Try changes' })).toBeNull();
	});
});
