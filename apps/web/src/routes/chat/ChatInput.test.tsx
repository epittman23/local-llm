import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getPrompts } from '@/lib/apis/prompts';
import { loadDraft, saveDraft } from '@/lib/chat/drafts';
import { ChatInput, type ChatInputHandle } from './ChatInput';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/lib/apis/knowledge', () => ({
	searchKnowledgeBases: vi.fn(async () => ({ items: [] })),
	searchKnowledgeFiles: vi.fn(async () => ({ items: [] }))
}));
vi.mock('@/lib/apis/prompts', () => ({ getPrompts: vi.fn(async () => []) }));
vi.mock('@/lib/settings/userSettings', () => ({ useUserSettings: () => ({ settings: {} }) }));
const auth = vi.hoisted(() => ({ status: 'authenticated' }));
vi.mock('@/lib/stores/authStore', () => ({
	useAuthStore: (sel: (s: unknown) => unknown) =>
		sel({ token: 't', status: auth.status, user: { id: 'u1', name: 'Test User' } })
}));

const nextFrame = () => act(() => new Promise<void>((done) => requestAnimationFrame(() => done())));

function show(props: Partial<Parameters<typeof ChatInput>[0]> = {}) {
	const onAddWeb = vi.fn();
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<TooltipProvider>
				<ChatInput
					onSubmit={vi.fn(() => true)}
					onStop={vi.fn()}
					generating={false}
					queued={[]}
					onRemoveQueued={vi.fn()}
					onAddWeb={onAddWeb}
					{...props}
				/>
			</TooltipProvider>
		</QueryClientProvider>
	);
	return { box: screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement, onAddWeb };
}

/** Types `value` with the caret at its end, as the browser would. */
function type(box: HTMLTextAreaElement, value: string) {
	fireEvent.change(box, { target: { value, selectionStart: value.length } });
	fireEvent.select(box, { target: { selectionStart: value.length } });
}

describe('ChatInput: placing the caret after a suggestion', () => {
	afterEach(cleanup);

	it('places it at once, so a key typed before the next frame stays where it was typed', async () => {
		// Placed a frame later, a letter typed before that frame went in at the
		// end and the frame then put the caret back in front of it.
		const { box, onAddWeb } = show();
		box.focus();
		type(box, 'hi #https://example.org/b');
		fireEvent.keyDown(box, { key: 'Enter' });
		expect(onAddWeb).toHaveBeenCalledWith(['https://example.org/b']);
		expect(box.value).toBe('hi ');
		expect(box.selectionStart).toBe(3);

		// A letter typed before the next frame.
		fireEvent.change(box, { target: { value: 'hi w', selectionStart: 4 } });
		expect(box.value).toBe('hi w');
		await nextFrame();
		expect(box.selectionStart).toBe(4);
	});

	it('takes focus back a frame later if something else took it (a dialog closing)', async () => {
		const { box } = show();
		box.focus();
		type(box, 'hi #https://example.org/b');
		fireEvent.keyDown(box, { key: 'Enter' });
		const elsewhere = document.createElement('button');
		document.body.append(elsewhere);
		elsewhere.focus();
		await nextFrame();
		expect(document.activeElement).toBe(box);
		expect(box.selectionStart).toBe(3);
		elsewhere.remove();
	});
});

describe('ChatInput: Enter while an attachment is uploading', () => {
	afterEach(cleanup);

	const uploading = { itemId: 'f1', type: 'text', name: 'Page', status: 'uploading' };
	const uploaded = { ...uploading, status: 'uploaded' };

	function showWith(files: Record<string, unknown>[]) {
		const onSubmit = vi.fn(() => true);
		const ui = (fs: Record<string, unknown>[], disabled = false) => (
			<QueryClientProvider client={new QueryClient()}>
				<TooltipProvider>
					<ChatInput
						onSubmit={onSubmit}
						onStop={vi.fn()}
						generating={false}
						queued={[]}
						onRemoveQueued={vi.fn()}
						files={fs}
						disabled={disabled}
					/>
				</TooltipProvider>
			</QueryClientProvider>
		);
		const { rerender } = render(ui(files));
		const box = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
		return {
			box,
			onSubmit,
			setFiles: (fs: Record<string, unknown>[], disabled = false) => rerender(ui(fs, disabled))
		};
	}
	const status = () => screen.queryByText('Sends when the upload finishes');

	it('holds the send, then sends once the upload is done', () => {
		const { box, onSubmit, setFiles } = showWith([uploading]);
		type(box, 'read this');
		fireEvent.keyDown(box, { key: 'Enter' });
		expect(onSubmit).not.toHaveBeenCalled();
		expect(status()).toBeTruthy();
		setFiles([uploaded]);
		expect(onSubmit).toHaveBeenCalledExactlyOnceWith('read this', [uploaded]);
		expect(status()).toBeNull();
		expect(box.value).toBe('');
	});

	it('lets go when the text is edited, and does not send when the upload is done', () => {
		const { box, onSubmit, setFiles } = showWith([uploading]);
		type(box, 'read this');
		fireEvent.keyDown(box, { key: 'Enter' });
		expect(status()).toBeTruthy();
		type(box, 'read this and');
		expect(status()).toBeNull();
		setFiles([uploaded]);
		expect(onSubmit).not.toHaveBeenCalled();
		expect(box.value).toBe('read this and');
	});

	it('lets go when the upload fails and is dropped: the message does not go without it', () => {
		const { box, onSubmit, setFiles } = showWith([uploading]);
		type(box, 'read this');
		fireEvent.keyDown(box, { key: 'Enter' });
		expect(status()).toBeTruthy();
		setFiles([]);
		expect(onSubmit).not.toHaveBeenCalled();
		expect(status()).toBeNull();
		expect(box.value).toBe('read this');
	});

	it('can be called off', () => {
		const { box, onSubmit, setFiles } = showWith([uploading]);
		type(box, 'read this');
		fireEvent.keyDown(box, { key: 'Enter' });
		fireEvent.click(screen.getByRole('button', { name: "Don't send when the upload finishes" }));
		expect(status()).toBeNull();
		setFiles([uploaded]);
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it('waits while the chat reloads, and sends after', () => {
		const { box, onSubmit, setFiles } = showWith([uploading]);
		type(box, 'read this');
		fireEvent.keyDown(box, { key: 'Enter' });
		// The upload ends while the chat is reloading (a tool call resolved, a missed reply end).
		setFiles([uploaded], true);
		expect(onSubmit).not.toHaveBeenCalled();
		expect(status()).toBeTruthy();
		setFiles([uploaded], false);
		expect(onSubmit).toHaveBeenCalledExactlyOnceWith('read this', [uploaded]);
	});

	it('lets go at once when one held upload is gone while another is still going', () => {
		const other = { itemId: 'f2', type: 'text', name: 'Other', status: 'uploading' };
		const { box, onSubmit, setFiles } = showWith([uploading, other]);
		type(box, 'read this');
		fireEvent.keyDown(box, { key: 'Enter' });
		expect(status()).toBeTruthy();
		setFiles([other]);
		expect(status()).toBeNull();
		setFiles([{ ...other, status: 'uploaded' }]);
		expect(onSubmit).not.toHaveBeenCalled();
		expect(box.value).toBe('read this');
	});
});

describe('ChatInput: a send waiting for the models (#659)', () => {
	afterEach(cleanup);

	it('says so, and can call it off', () => {
		const onCancelWaiting = vi.fn();
		show({ waiting: true, onCancelWaiting });
		expect(screen.getByRole('status').textContent).toBe('Sends when the models load');
		fireEvent.click(screen.getByRole('button', { name: "Don't send when the models load" }));
		expect(onCancelWaiting).toHaveBeenCalledTimes(1);
	});

	it('says nothing when no send is waiting', () => {
		show();
		expect(screen.queryByRole('status')).toBeNull();
	});
});

describe('ChatInput: a suggestion list that shrinks under the selection (#623)', () => {
	afterEach(cleanup);

	const model = (id: string) => ({ id, name: id, info: { meta: {} } }) as never;
	const three = [model('alpha'), model('beta'), model('gamma')];

	/** The input with `models`, re-rendered with fewer by `shrink`: the query stays as it was. */
	function withModels(models: unknown[]) {
		const onAtModel = vi.fn();
		const ui = (list: unknown[]) => (
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<TooltipProvider>
					<ChatInput
						onSubmit={vi.fn(() => true)}
						onStop={vi.fn()}
						generating={false}
						queued={[]}
						onRemoveQueued={vi.fn()}
						onAtModel={onAtModel}
						models={list as never}
					/>
				</TooltipProvider>
			</QueryClientProvider>
		);
		const { rerender } = render(ui(models));
		const box = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
		return { box, onAtModel, shrink: (list: unknown[]) => rerender(ui(list)) };
	}
	const highlighted = () =>
		screen
			.getAllByRole('option')
			.filter((o) => o.getAttribute('aria-selected') === 'true')
			.map((o) => o.textContent);

	it('highlights the last suggestion left, and Enter picks it', () => {
		const { box, onAtModel, shrink } = withModels(three);
		box.focus();
		type(box, '@');
		fireEvent.keyDown(box, { key: 'ArrowDown' });
		fireEvent.keyDown(box, { key: 'ArrowDown' });
		expect(highlighted()).toEqual([expect.stringContaining('gamma')]);

		shrink([three[0]]);
		expect(highlighted()).toEqual([expect.stringContaining('alpha')]);
		fireEvent.keyDown(box, { key: 'Enter' });
		expect(onAtModel).toHaveBeenCalledWith(three[0]);
	});

	it('steps the arrow keys from what is highlighted', () => {
		const { box, shrink } = withModels(three);
		box.focus();
		type(box, '@');
		fireEvent.keyDown(box, { key: 'ArrowDown' });
		fireEvent.keyDown(box, { key: 'ArrowDown' });

		shrink(three.slice(0, 2));
		expect(highlighted()).toEqual([expect.stringContaining('beta')]);
		fireEvent.keyDown(box, { key: 'ArrowUp' });
		expect(highlighted()).toEqual([expect.stringContaining('alpha')]);
	});
});

describe('ChatInput: removing an attachment', () => {
	afterEach(cleanup);

	it('offers a Remove button on each attached file, which removes that file', () => {
		const onRemoveFile = vi.fn();
		render(
			<QueryClientProvider client={new QueryClient()}>
				<TooltipProvider>
					<ChatInput
						onSubmit={vi.fn(() => true)}
						onStop={vi.fn()}
						generating={false}
						queued={[]}
						onRemoveQueued={vi.fn()}
						files={[{ itemId: 'f1', type: 'text', name: 'notes.txt', status: 'uploaded' }]}
						onRemoveFile={onRemoveFile}
					/>
				</TooltipProvider>
			</QueryClientProvider>
		);
		fireEvent.click(screen.getByRole('button', { name: 'Remove notes.txt' }));
		expect(onRemoveFile).toHaveBeenCalledExactlyOnceWith('f1');
	});

	it('names the Remove button "Remove file" for an attachment without a name', () => {
		render(
			<QueryClientProvider client={new QueryClient()}>
				<TooltipProvider>
					<ChatInput
						onSubmit={vi.fn(() => true)}
						onStop={vi.fn()}
						generating={false}
						queued={[]}
						onRemoveQueued={vi.fn()}
						files={[{ itemId: 'f2', type: 'text', status: 'uploaded' }]}
						onRemoveFile={vi.fn()}
					/>
				</TooltipProvider>
			</QueryClientProvider>
		);
		expect(screen.getByRole('button', { name: 'Remove file' })).toBeTruthy();
	});
});

/** `window.matchMedia` answering `true` for the queries given. */
function media(...on: string[]) {
	vi.stubGlobal('matchMedia', (query: string) => ({
		matches: on.includes(query),
		media: query,
		addEventListener: vi.fn(),
		removeEventListener: vi.fn()
	}));
}

function input(props: Partial<Parameters<typeof ChatInput>[0]> = {}) {
	const ref = createRef<ChatInputHandle>();
	const onSubmit = vi.fn(() => true);
	const ui = (p: Partial<Parameters<typeof ChatInput>[0]>) => (
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<MemoryRouter>
				<TooltipProvider>
					<ChatInput
						ref={ref}
						onSubmit={onSubmit}
						onStop={vi.fn()}
						generating={false}
						queued={[]}
						onRemoveQueued={vi.fn()}
						{...p}
					/>
				</TooltipProvider>
			</MemoryRouter>
		</QueryClientProvider>
	);
	const view = render(ui(props));
	return {
		ref,
		onSubmit,
		box: () => screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement,
		rerender: (p: Partial<Parameters<typeof ChatInput>[0]>) => view.rerender(ui({ ...props, ...p })),
		unmount: view.unmount
	};
}

describe('ChatInput: drafts (#997, #1061)', () => {
	afterEach(() => {
		cleanup();
		sessionStorage.clear();
		auth.status = 'authenticated';
	});

	it('keeps what is typed for its chat, and puts it back when the box mounts again (a reload)', () => {
		const first = input({ draftKey: 'c1' });
		type(first.box(), 'a long question');
		expect(loadDraft('c1')).toBe('a long question');
		first.unmount();
		expect(input({ draftKey: 'c1' }).box().value).toBe('a long question');
	});

	it('never carries a draft into another chat (#217), and restoreDraft reads the chat now shown', () => {
		saveDraft('c2', 'for chat two');
		const view = input({ draftKey: 'c1' });
		type(view.box(), 'for chat one');
		view.rerender({ draftKey: 'c2' });
		act(() => view.ref.current?.restoreDraft());
		expect(view.box().value).toBe('for chat two');
		view.rerender({ draftKey: 'new:' });
		act(() => view.ref.current?.restoreDraft());
		expect(view.box().value).toBe('');
		expect(loadDraft('c1')).toBe('for chat one');
	});

	it('forgets a draft emptied by hand', () => {
		const view = input({ draftKey: 'c1' });
		type(view.box(), 'x');
		type(view.box(), '');
		expect(loadDraft('c1')).toBe('');
	});

	it('keeps a sent message until the reply ends, then forgets it', () => {
		const view = input({ draftKey: 'new:' });
		type(view.box(), 'hello');
		fireEvent.keyDown(view.box(), { key: 'Enter' });
		expect(view.onSubmit).toHaveBeenCalledWith('hello', []);
		expect(view.box().value).toBe('');
		expect(loadDraft('new:')).toBe('hello');
		// The chat gets its id while the reply is written; the new chat's draft goes when it ends.
		view.rerender({ draftKey: 'c9', generating: true });
		expect(loadDraft('new:')).toBe('hello');
		view.rerender({ draftKey: 'c9', generating: false });
		expect(loadDraft('new:')).toBe('');
	});

	it('keeps a sent message when the session ran out before the reply, for after sign-in (#1061)', () => {
		const view = input({ draftKey: 'new:' });
		type(view.box(), 'sent into an expired session');
		fireEvent.keyDown(view.box(), { key: 'Enter' });
		view.rerender({ generating: true });
		auth.status = 'anonymous';
		view.rerender({ generating: false });
		view.unmount();
		auth.status = 'authenticated';
		expect(input({ draftKey: 'new:' }).box().value).toBe('sent into an expired session');
	});

	it('new text typed after a send replaces the sent draft, and is not forgotten when the reply ends', () => {
		const view = input({ draftKey: 'c1' });
		type(view.box(), 'one');
		fireEvent.keyDown(view.box(), { key: 'Enter' });
		view.rerender({ generating: true });
		type(view.box(), 'two');
		view.rerender({ generating: false });
		expect(loadDraft('c1')).toBe('two');
	});

	it('does not put back a draft that was just sent, when its chat is opened again mid-reply', () => {
		const view = input({ draftKey: 'new:' });
		type(view.box(), 'already sent');
		fireEvent.keyDown(view.box(), { key: 'Enter' });
		view.rerender({ draftKey: 'c9', generating: true });
		// New chat pressed while the reply is still being written.
		view.rerender({ draftKey: 'new:', generating: true });
		act(() => view.ref.current?.restoreDraft());
		expect(view.box().value).toBe('');
		view.rerender({ draftKey: 'new:', generating: false });
		expect(loadDraft('new:')).toBe('');
	});

	it('keeps text the page puts in, and treats setText("") as the page having sent it', () => {
		const view = input({ draftKey: 'c1' });
		act(() => view.ref.current?.setText('a follow-up to edit'));
		expect(loadDraft('c1')).toBe('a follow-up to edit');
		// Sent from the web-search confirmation: kept until the reply ends.
		act(() => view.ref.current?.setText(''));
		expect(loadDraft('c1')).toBe('a follow-up to edit');
		view.rerender({ generating: true });
		view.rerender({ generating: false });
		expect(loadDraft('c1')).toBe('');
	});

	it('keeps nothing without a draftKey', () => {
		const view = input();
		type(view.box(), 'not kept');
		expect(sessionStorage.length).toBe(0);
		act(() => view.ref.current?.restoreDraft());
		expect(view.box().value).toBe('');
	});
});

describe('ChatInput: Enter on a touch screen (#947)', () => {
	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it('is a new line there: only the Send button sends', () => {
		media('(pointer: coarse)');
		const view = input();
		type(view.box(), 'first line');
		const enter = fireEvent.keyDown(view.box(), { key: 'Enter' });
		expect(enter).toBe(true);
		expect(view.onSubmit).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
		expect(view.onSubmit).toHaveBeenCalledWith('first line', []);
	});

	it('still sends with a fine pointer', () => {
		media();
		const view = input();
		type(view.box(), 'sent');
		fireEvent.keyDown(view.box(), { key: 'Enter' });
		expect(view.onSubmit).toHaveBeenCalledWith('sent', []);
	});
});

describe('ChatInput: placeholder and edge (#1083, FRM-1)', () => {
	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it('names the three triggers, shorter on a phone, and keeps the field named "Message"', () => {
		media();
		const wide = input();
		expect(wide.box().placeholder).toBe('Message. Type / for prompts, # for files, @ for a model');
		cleanup();
		media('(max-width: 479px)');
		expect(input().box().placeholder).toBe('Message. / prompts, # files, @ model');
		cleanup();
		expect(input({ placeholder: 'New chat in Notes' }).box().placeholder).toBe('New chat in Notes');
	});

	it('draws the box with the field’s edge and fill', () => {
		const view = input();
		const field = view.box().closest('[data-composite-field]');
		expect(field?.className).toContain('border-border-control');
		expect(field?.className).toContain('bg-surface-1');
	});
});

describe('ChatInput: a trigger with nothing to offer (#1083, STA-3)', () => {
	afterEach(() => {
		cleanup();
		vi.mocked(getPrompts).mockResolvedValue([]);
	});

	it('"/" with no saved prompts says so and links to Workspace > Prompts; Escape closes it', async () => {
		const view = input();
		view.box().focus();
		type(view.box(), '/');
		const row = await screen.findByRole('status');
		expect(row.textContent).toBe('No saved prompts yet. Create one in Workspace > Prompts');
		expect(screen.getByRole('link', { name: 'Create one in Workspace > Prompts' }).getAttribute('href')).toBe(
			'/workspace/prompts'
		);
		fireEvent.keyDown(view.box(), { key: 'Escape' });
		expect(screen.queryByRole('status')).toBeNull();
	});

	it('"/" with prompts that do not match names the search; Enter still sends', async () => {
		vi.mocked(getPrompts).mockResolvedValue([
			{ command: 'derive', content: 'Derive it', title: 'A very long prompt title that would push the command out' }
		] as never);
		const view = input();
		view.box().focus();
		type(view.box(), '/');
		const option = await screen.findByRole('option');
		expect(option.firstElementChild?.className).toContain('shrink-0');
		expect(option.lastElementChild?.className).toContain('truncate');
		type(view.box(), '/zzz');
		await waitFor(() => expect(screen.getByRole('status').textContent).toBe('No prompts match “zzz”'));
		fireEvent.keyDown(view.box(), { key: 'Enter' });
		expect(view.onSubmit).toHaveBeenCalledWith('/zzz', []);
	});

	it('"#" with no knowledge says so once the search has answered, with a way to add some; Escape closes it', async () => {
		const view = input();
		view.box().focus();
		type(view.box(), '#');
		const row = await screen.findByRole('status');
		expect(row.textContent).toBe('No knowledge or files yet. Create one in Workspace > Knowledge');
		expect(screen.getByRole('link', { name: 'Create one in Workspace > Knowledge' }).getAttribute('href')).toBe(
			'/workspace/knowledge'
		);
		fireEvent.keyDown(view.box(), { key: 'Escape' });
		expect(screen.queryByRole('status')).toBeNull();
	});

	it('"#" with knowledge that does not match names the search, without the link', async () => {
		const view = input();
		view.box().focus();
		type(view.box(), '#zzz');
		await waitFor(() => expect(screen.getByRole('status').textContent).toBe('No knowledge or files match “zzz”'));
		expect(screen.queryByRole('link')).toBeNull();
	});

	it('"@" lists models as two-line rows, and names a search with no match', () => {
		const view = input({
			models: [{ id: 'math', name: 'Math', info: { base_model_id: 'qwen/qwen3.6-27b' } }] as never
		});
		view.box().focus();
		type(view.box(), '@');
		expect(screen.getByRole('option').textContent).toBe('MMathqwen/qwen3.6-27b');
		type(view.box(), '@zzz');
		expect(screen.getByRole('status').textContent).toBe('No models match “zzz”');
	});
});
