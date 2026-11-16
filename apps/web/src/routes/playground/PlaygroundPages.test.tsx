import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { PlaygroundChat, PlaygroundCompletions, PlaygroundImages, PlaygroundLayout } from './PlaygroundPages';
import { emptyChat, emptyCompletions, usePlaygroundStore } from './playgroundStore';

const { imageGenerations, imageEdits, saveAs, toast, chatCompletion, textCompletion, features, openSettings } =
	vi.hoisted(() => ({
		imageGenerations: vi.fn(),
		imageEdits: vi.fn(),
		saveAs: vi.fn(),
		toast: { error: vi.fn(), success: vi.fn() },
		chatCompletion: vi.fn(),
		textCompletion: vi.fn(),
		features: { enable_image_generation: true },
		openSettings: vi.fn()
	}));

vi.mock('sonner', () => ({ toast }));
vi.mock('file-saver', () => ({ default: saveAs }));
vi.mock('@/lib/apis/images', () => ({ imageGenerations, imageEdits }));
vi.mock('@/lib/apis', () => ({ getModels: vi.fn().mockResolvedValue([]) }));
vi.mock('@/lib/stores/authStore', () => ({
	useAuthStore: (sel: (s: unknown) => unknown) => sel({ token: 't', user: { id: 'me', role: 'admin' } })
}));
vi.mock('@/lib/settings/userSettings', () => ({ useUserSettings: () => ({ settings: {} }) }));
vi.mock('@/lib/apis/openai', () => ({ chatCompletion, textCompletion }));
vi.mock('@/lib/stores/configStore', () => ({
	useConfigStore: (sel: (s: unknown) => unknown) => sel({ config: { features } })
}));
vi.mock('@/lib/stores/settingsModalStore', () => ({
	useSettingsModalStore: (sel: (s: unknown) => unknown) => sel({ openSettings })
}));
vi.mock('@/routes/common/FeatureGate', () => ({ FeatureGate: ({ children }: { children: unknown }) => children }));

const wrap = (node: React.ReactNode, path = '/playground') =>
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<TooltipProvider>
				<MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>
			</TooltipProvider>
		</QueryClientProvider>
	);

const chunk = (piece: object) => `data: ${JSON.stringify(piece)}\n\n`;
/** A streamed answer: chat deltas, or a text completion's `text`, then a usage chunk. */
const streamed = (pieces: string[], kind: 'chat' | 'text' = 'chat') =>
	new Response(
		pieces.map((p) => chunk({ choices: [kind === 'chat' ? { delta: { content: p } } : { text: p }] })).join('') +
			chunk({ choices: [], usage: { completion_tokens: 7 } }) +
			'data: [DONE]\n\n'
	);
/** chatCompletion's mock: (token, body, url, controller). */
const answer = (pieces: string[]) =>
	vi.fn(async (_t: string, _b: object, _u?: unknown, c?: AbortController) => [streamed(pieces), c]);
const failing = (detail: string) =>
	vi.fn(async () => [new Response(JSON.stringify({ detail }), { status: 404 }), new AbortController()]);

beforeEach(() => {
	vi.resetAllMocks();
	features.enable_image_generation = true;
	sessionStorage.clear();
	usePlaygroundStore.setState({
		chat: { ...emptyChat, modelId: 'm' },
		completions: { ...emptyCompletions, modelId: 'm' },
		imagePrompt: ''
	});
});
afterEach(cleanup);

describe('the playground tabs', () => {
	const layout = (path: string) =>
		wrap(
			<Routes>
				<Route path="/playground" element={<PlaygroundLayout />}>
					<Route index element={<div>chat page</div>} />
					<Route path="images" element={<div>images page</div>} />
				</Route>
			</Routes>,
			path
		);

	it('marks the open tab as the current page and the others not, under the Playground heading', () => {
		layout('/playground/images');
		expect(screen.getByRole('heading', { level: 1, name: 'Playground' })).toBeInTheDocument();
		expect(screen.getByRole('navigation', { name: 'Playground' })).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Images' }).getAttribute('aria-current')).toBe('page');
		expect(screen.getByRole('link', { name: 'Chat' }).getAttribute('aria-current')).toBeNull();
		expect(screen.getByRole('link', { name: 'Completions' }).className).toContain('hover:text-foreground');
		expect(screen.getByText('images page')).toBeInTheDocument();
	});

	it('marks Chat as the current tab on the index route only', () => {
		layout('/playground');
		expect(screen.getByRole('link', { name: 'Chat' }).getAttribute('aria-current')).toBe('page');
		expect(screen.getByRole('link', { name: 'Images' }).getAttribute('aria-current')).toBeNull();
	});
});

describe('the chat playground', () => {
	it('makes System Instructions a target at least 24 px tall, 44 px on touch (LAY-3), that opens the field', () => {
		wrap(<PlaygroundChat />);
		const toggle = screen.getByRole('button', { name: /System Instructions/ });
		expect(toggle.className).toContain('min-h-6');
		expect(toggle.className).toContain('pointer-coarse:min-h-11');
		fireEvent.click(toggle);
		expect(toggle.getAttribute('aria-expanded')).toBe('true');
		expect(screen.getByRole('textbox', { name: 'System Instructions' })).toBeInTheDocument();
	});
});

describe('the image playground results', () => {
	const url = 'data:image/png;base64,iVBORw0KGgo=';

	it('refuses to run without a prompt', () => {
		wrap(<PlaygroundImages />);
		expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled();
		expect(imageGenerations).not.toHaveBeenCalled();
	});

	it('lists a generated image and downloads it when it is pressed', async () => {
		imageGenerations.mockResolvedValue([{ url }]);
		const blob = new Blob(['x']);
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ blob: async () => blob }));
		wrap(<PlaygroundImages />);
		fireEvent.change(screen.getByLabelText('Image prompt'), { target: { value: 'a red fox' } });
		fireEvent.click(screen.getByRole('button', { name: 'Run' }));
		await waitFor(() => expect(imageGenerations).toHaveBeenCalledWith('t', 'a red fox'));
		fireEvent.click(await screen.findByRole('button', { name: 'Download image 1' }));
		await waitFor(() => expect(saveAs).toHaveBeenCalledWith(blob, expect.stringMatching(/^image-\d+-0\.png$/)));
		vi.unstubAllGlobals();
	});

	it('says so when the download fails', async () => {
		imageGenerations.mockResolvedValue([{ url }]);
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
		wrap(<PlaygroundImages />);
		fireEvent.change(screen.getByLabelText('Image prompt'), { target: { value: 'a red fox' } });
		fireEvent.click(screen.getByRole('button', { name: 'Run' }));
		fireEvent.click(await screen.findByRole('button', { name: 'Download image 1' }));
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to download image'));
		vi.unstubAllGlobals();
	});
});

describe('the Images tab while image generation is off (S6-D7)', () => {
	const layout = () =>
		wrap(
			<Routes>
				<Route path="/playground" element={<PlaygroundLayout />}>
					<Route index element={<div>chat page</div>} />
				</Route>
			</Routes>
		);

	it('is not offered', () => {
		features.enable_image_generation = false;
		layout();
		expect(screen.queryByRole('link', { name: 'Images' })).toBeNull();
		expect(screen.getByRole('link', { name: 'Completions' })).toBeInTheDocument();
	});

	it('a direct link says it is off, where to turn it on, and cannot run', () => {
		features.enable_image_generation = false;
		usePlaygroundStore.setState({ imagePrompt: 'a red fox' });
		wrap(<PlaygroundImages />);
		expect(screen.getByText('Image generation is off')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled();
		fireEvent.keyDown(screen.getByLabelText('Image prompt'), { key: 'Enter', ctrlKey: true });
		expect(imageGenerations).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole('button', { name: 'Open Images settings' }));
		expect(openSettings).toHaveBeenCalledWith('admin:images');
	});

	it('words the server\'s "no permission" for a feature switched off as what it is (WRD-4)', async () => {
		imageGenerations.mockRejectedValue('You do not have permission to access this resource.');
		wrap(<PlaygroundImages />);
		fireEvent.change(screen.getByLabelText('Image prompt'), { target: { value: 'a red fox' } });
		fireEvent.keyDown(screen.getByLabelText('Image prompt'), { key: 'Enter', metaKey: true });
		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith('Image generation is off. Turn it on in Admin Settings > Images.')
		);
	});

	it("names another failure and keeps the server's words behind Details", async () => {
		imageGenerations.mockRejectedValue('Upstream timed out');
		wrap(<PlaygroundImages />);
		fireEvent.change(screen.getByLabelText('Image prompt'), { target: { value: 'a red fox' } });
		fireEvent.click(screen.getByRole('button', { name: 'Run' }));
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't make the image", expect.anything()));
	});
});

describe('the chat transcript (#934, #1076, #968, #1031)', () => {
	it('renders a reply as the chat does, with its speed, and shows its source on demand', async () => {
		chatCompletion.mockImplementation(answer(['## Mean\n\n', '`x̄` is the mean.']));
		usePlaygroundStore.setState((s) => ({ chat: { ...s.chat, draft: 'Define the mean' } }));
		wrap(<PlaygroundChat />);
		fireEvent.click(screen.getByRole('button', { name: 'Run' }));
		const reply = await screen.findByRole('region', { name: 'Assistant message 2' });
		await waitFor(() => expect(within(reply).getByRole('heading', { name: 'Mean' })).toBeInTheDocument());
		expect(screen.getByText(/^First token in \d+\.\d\d s · 7 tokens/)).toBeInTheDocument();
		expect(chatCompletion.mock.calls[0][1]).toEqual({
			model: 'm',
			stream: true,
			messages: [{ role: 'user', content: 'Define the mean' }]
		});

		const toggle = screen.getByRole('button', { name: 'Source of message 2' });
		fireEvent.click(toggle);
		expect(toggle.getAttribute('aria-pressed')).toBe('true');
		const source = screen.getByRole('textbox', { name: 'assistant message 2' });
		expect(source).toHaveValue('## Mean\n\n`x̄` is the mean.');
		expect(source.className).toContain('font-code');
		// The role labels are in sentence case (TYP-7).
		expect(within(screen.getByRole('list')).getByText('User')).toBeInTheDocument();
		expect(within(screen.getByRole('list')).getByText('Assistant')).toBeInTheDocument();
	});

	it('Regenerate replaces the last reply rather than adding to it (#1076)', async () => {
		chatCompletion.mockImplementation(answer(['Second answer.']));
		usePlaygroundStore.setState((s) => ({
			chat: {
				...s.chat,
				messages: [
					{ role: 'user', content: 'Q' },
					{ role: 'assistant', content: 'First answer.' }
				]
			}
		}));
		wrap(<PlaygroundChat />);
		fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
		await waitFor(() =>
			expect(usePlaygroundStore.getState().chat.messages).toEqual([
				{ role: 'user', content: 'Q' },
				{ role: 'assistant', content: 'Second answer.', stats: expect.any(Object) }
			])
		);
		expect(chatCompletion.mock.calls[0][1].messages).toEqual([{ role: 'user', content: 'Q' }]);
	});

	it('Run is disabled with nothing to send', () => {
		wrap(<PlaygroundChat />);
		expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled();
		expect(screen.getByText(/^No messages yet/)).toBeInTheDocument();
	});

	it('Ctrl+Enter and Cmd+Enter run from the message box, which names the shortcut (#1031)', async () => {
		chatCompletion.mockImplementation(answer(['ok']));
		wrap(<PlaygroundChat />);
		const box = screen.getByLabelText('New message');
		expect(box.getAttribute('aria-keyshortcuts')).toBe('Control+Enter Meta+Enter');
		expect(screen.getByRole('button', { name: 'Run' }).getAttribute('aria-keyshortcuts')).toBe(
			'Control+Enter Meta+Enter'
		);
		fireEvent.change(box, { target: { value: 'Hi' } });
		fireEvent.keyDown(box, { key: 'Enter' });
		expect(chatCompletion).not.toHaveBeenCalled();
		fireEvent.keyDown(box, { key: 'Enter', isComposing: true, ctrlKey: true });
		expect(chatCompletion).not.toHaveBeenCalled();
		fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
		await waitFor(() => expect(chatCompletion).toHaveBeenCalledTimes(1));
		await screen.findByRole('region', { name: 'Assistant message 2' });
		fireEvent.change(box, { target: { value: 'Again' } });
		fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
		await waitFor(() => expect(chatCompletion).toHaveBeenCalledTimes(2));
	});

	it('Escape in the message box stops a run, and the unanswered reply is dropped', async () => {
		chatCompletion.mockImplementation(
			(_t: string, _b: object, _u: unknown, c: AbortController) =>
				new Promise((_resolve, reject) =>
					c.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
				)
		);
		usePlaygroundStore.setState((s) => ({ chat: { ...s.chat, draft: 'Hi' } }));
		wrap(<PlaygroundChat />);
		fireEvent.click(screen.getByRole('button', { name: 'Run' }));
		expect(await screen.findByText('Waiting for the first token…')).toBeInTheDocument();
		fireEvent.keyDown(screen.getByLabelText('New message'), { key: 'Escape' });
		await waitFor(() => expect(screen.getByRole('button', { name: 'Run' })).toBeInTheDocument());
		expect(usePlaygroundStore.getState().chat.messages).toEqual([{ role: 'user', content: 'Hi' }]);
		expect(screen.queryByRole('alert')).toBeNull();
	});

	it('shows a failed run in place, under the message that caused it, with Retry (#968)', async () => {
		chatCompletion.mockImplementation(failing('Model not found'));
		usePlaygroundStore.setState((s) => ({ chat: { ...s.chat, draft: 'Hi' } }));
		wrap(<PlaygroundChat />);
		fireEvent.click(screen.getByRole('button', { name: 'Run' }));
		const row = await screen.findByRole('alert');
		expect(within(row).getByText("The model didn't answer")).toBeInTheDocument();
		expect(within(row).getByText('Model not found')).toBeInTheDocument();
		expect(toast.error).not.toHaveBeenCalled();
		expect(usePlaygroundStore.getState().chat.messages).toEqual([{ role: 'user', content: 'Hi' }]);

		chatCompletion.mockImplementation(answer(['Found it.']));
		fireEvent.click(within(row).getByRole('button', { name: 'Retry' }));
		await screen.findByRole('region', { name: 'Assistant message 2' });
		expect(screen.queryByRole('alert')).toBeNull();
		expect(chatCompletion.mock.calls[1][1].messages).toEqual([{ role: 'user', content: 'Hi' }]);
	});

	it('the role is a choice named for what it sets, its words matching what it shows (#987)', () => {
		wrap(<PlaygroundChat />);
		const roles = screen.getByRole('radiogroup', { name: 'Message role' });
		expect(within(roles).getByRole('radio', { name: 'User' })).toBeChecked();
		fireEvent.click(within(roles).getByRole('radio', { name: 'Assistant' }));
		expect(usePlaygroundStore.getState().chat.role).toBe('assistant');
		expect(screen.getByLabelText('New message')).toHaveAttribute('placeholder', 'Enter an assistant message here');
	});

	it('Add puts the draft in the transcript and turns the role over', () => {
		usePlaygroundStore.setState((s) => ({ chat: { ...s.chat, draft: 'Q' } }));
		wrap(<PlaygroundChat />);
		fireEvent.click(screen.getByRole('button', { name: 'Add' }));
		expect(usePlaygroundStore.getState().chat).toMatchObject({
			messages: [{ role: 'user', content: 'Q' }],
			draft: '',
			role: 'assistant'
		});
		fireEvent.click(screen.getByRole('button', { name: 'Delete message 1' }));
		expect(usePlaygroundStore.getState().chat.messages).toEqual([]);
	});

	it('an empty message is shown as its field, and typing in it edits the transcript', () => {
		usePlaygroundStore.setState((s) => ({ chat: { ...s.chat, messages: [{ role: 'user', content: '' }] } }));
		wrap(<PlaygroundChat />);
		fireEvent.change(screen.getByRole('textbox', { name: 'user message 1' }), { target: { value: 'typed' } });
		expect(usePlaygroundStore.getState().chat.messages[0].content).toBe('typed');
	});
});

describe('keeping the work (#969)', () => {
	it('a conversation survives the tab being left and opened again', () => {
		const first = wrap(<PlaygroundChat />);
		fireEvent.click(screen.getByRole('button', { name: /System Instructions/ }));
		fireEvent.change(screen.getByRole('textbox', { name: 'System Instructions' }), { target: { value: 'Be brief' } });
		fireEvent.change(screen.getByLabelText('New message'), { target: { value: 'Draft' } });
		first.unmount();
		wrap(<PlaygroundChat />);
		expect(screen.getByLabelText('New message')).toHaveValue('Draft');
		expect(screen.getByText('Be brief')).toBeInTheDocument();
		expect(JSON.parse(sessionStorage.getItem('lllm-playground') ?? '{}').state.chat.system).toBe('Be brief');
	});

	it('Clear conversation asks first, then empties it and keeps the model', async () => {
		usePlaygroundStore.setState((s) => ({
			chat: { ...s.chat, system: 'S', messages: [{ role: 'user', content: 'Q' }] }
		}));
		wrap(<PlaygroundChat />);
		fireEvent.pointerDown(screen.getByRole('button', { name: 'More options' }), { button: 0, ctrlKey: false });
		fireEvent.click(await screen.findByRole('menuitem', { name: 'Clear conversation' }));
		const dialog = await screen.findByRole('alertdialog', { name: 'Clear conversation?' });
		expect(within(dialog).getByText(/Its message and the system instructions are removed/)).toBeInTheDocument();
		fireEvent.click(within(dialog).getByRole('button', { name: 'Clear conversation' }));
		expect(usePlaygroundStore.getState().chat).toMatchObject({ messages: [], system: '', modelId: 'm' });
	});

	it('the image results are not written to sessionStorage, only the prompt', () => {
		act(() => usePlaygroundStore.getState().setImagePrompt('a fox'));
		const stored = JSON.parse(sessionStorage.getItem('lllm-playground') ?? '{}').state;
		expect(Object.keys(stored).sort()).toEqual(['chat', 'completions', 'imagePrompt']);
		expect(stored.imagePrompt).toBe('a fox');
	});
});

describe('the completions playground (#1108, S6-D6)', () => {
	const text = (pieces: string[]) =>
		vi.fn(async (_t: string, _b: object, c: AbortController) => [streamed(pieces, 'text'), c]);

	it('sends a text completion and sets the continuation apart after your text', async () => {
		textCompletion.mockImplementation(text([' the mean of', ' a large sample']));
		usePlaygroundStore.setState((s) => ({
			completions: { ...s.completions, prompt: 'The central limit theorem states that', params: { temperature: 0.3 } }
		}));
		wrap(<PlaygroundCompletions />);
		expect(screen.getByLabelText('Text to continue')).toHaveAttribute(
			'placeholder',
			'The central limit theorem states that'
		);
		fireEvent.click(screen.getByRole('button', { name: 'Run' }));
		const continuation = await screen.findByRole('region', { name: 'Continuation' });
		await waitFor(() => expect(continuation).toHaveTextContent('the mean of a large sample'));
		expect(textCompletion.mock.calls[0][1]).toEqual({
			model: 'm',
			stream: true,
			prompt: 'The central limit theorem states that',
			params: { temperature: 0.3 }
		});
		expect(screen.getByText(/^First token in .* · 7 tokens/)).toBeInTheDocument();
		expect(screen.getByLabelText('Text to continue')).toHaveValue('The central limit theorem states that');

		fireEvent.click(screen.getByRole('button', { name: 'Add to text' }));
		expect(screen.getByLabelText('Text to continue')).toHaveValue(
			'The central limit theorem states that the mean of a large sample'
		);
		expect(screen.queryByRole('region', { name: 'Continuation' })).toBeNull();
	});

	it('runs with Ctrl+Enter, has Controls, and keeps the composite field clear of toasts', async () => {
		textCompletion.mockImplementation(text(['x']));
		usePlaygroundStore.setState((s) => ({ completions: { ...s.completions, prompt: 'Once' } }));
		wrap(<PlaygroundCompletions />);
		expect(screen.getByLabelText('Text to continue').closest('[data-composite-field]')).not.toBeNull();
		expect(screen.getByRole('button', { name: 'Controls' })).toBeInTheDocument();
		fireEvent.keyDown(screen.getByLabelText('Text to continue'), { key: 'Enter', ctrlKey: true });
		await waitFor(() => expect(textCompletion).toHaveBeenCalledTimes(1));
	});

	it('cannot run without text, and shows a failure in place with Retry', async () => {
		wrap(<PlaygroundCompletions />);
		expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled();
		cleanup();
		textCompletion.mockImplementation(
			vi.fn(async (_t: string, _b: object, c: AbortController) => [
				new Response(JSON.stringify({ detail: "This model's connection doesn't offer text completion" }), {
					status: 400
				}),
				c
			])
		);
		usePlaygroundStore.setState((s) => ({ completions: { ...s.completions, prompt: 'Once' } }));
		wrap(<PlaygroundCompletions />);
		fireEvent.click(screen.getByRole('button', { name: 'Run' }));
		const row = await screen.findByRole('alert');
		expect(within(row).getByText("This model's connection doesn't offer text completion")).toBeInTheDocument();
		fireEvent.click(within(row).getByRole('button', { name: 'Retry' }));
		await waitFor(() => expect(textCompletion).toHaveBeenCalledTimes(2));
	});

	it('asks for a model before running when none is chosen', () => {
		usePlaygroundStore.setState((s) => ({ completions: { ...s.completions, modelId: '', prompt: 'Once' } }));
		wrap(<PlaygroundCompletions />);
		fireEvent.click(screen.getByRole('button', { name: 'Run' }));
		expect(toast.error).toHaveBeenCalledWith('Choose a model to run.');
		expect(textCompletion).not.toHaveBeenCalled();
	});
});
