import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { verifyOllamaConnection } from '@/lib/apis/ollama';
import { verifyOpenAIConnection } from '@/lib/apis/openai';
import { useAuthStore } from '@/lib/stores/authStore';
import { AddConnectionModal } from './AddConnectionModal';
import type { Connection } from './connectionModel';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/apis/openai', () => ({ verifyOpenAIConnection: vi.fn() }));
vi.mock('@/lib/apis/ollama', () => ({ verifyOllamaConnection: vi.fn() }));

beforeAll(() => {
	// Radix Select measures and captures the pointer, which jsdom does not do.
	Element.prototype.scrollIntoView = vi.fn();
	Element.prototype.hasPointerCapture = vi.fn(() => false);
	Element.prototype.releasePointerCapture = vi.fn();
});

beforeEach(() => {
	vi.clearAllMocks();
	useAuthStore.setState({ token: 'jwt' } as never);
});

const SAVED: Connection = {
	url: 'http://127.0.0.1:8090/v1',
	key: '',
	config: { enable: true, connection_type: 'local', auth_type: 'none' }
};

function renderModal(props: Partial<Parameters<typeof AddConnectionModal>[0]> = {}) {
	const onSubmit = vi.fn();
	const onDelete = vi.fn();
	const onOpenChange = vi.fn();
	render(
		<TooltipProvider>
			<AddConnectionModal open onOpenChange={onOpenChange} onSubmit={onSubmit} onDelete={onDelete} {...props} />
		</TooltipProvider>
	);
	return { onSubmit, onDelete, onOpenChange, dialog: screen.getByRole('dialog') };
}

const url = () => screen.getByLabelText('URL');
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save' }));

describe('AddConnectionModal (#933)', () => {
	it('labels every field on the shared controls, with two-way choices as segmented controls', () => {
		const { dialog } = renderModal();
		expect(within(dialog).getByRole('heading', { name: 'Add connection' })).toBeTruthy();
		expect(screen.getByRole('radiogroup', { name: 'Connection type' })).toBeTruthy();
		expect(screen.getByRole('radiogroup', { name: 'API type' })).toBeTruthy();
		expect(url().getAttribute('data-slot')).toBe('input');
		expect(screen.getByRole('switch', { name: 'Enabled' })).toBeTruthy();
		expect(screen.getByRole('combobox', { name: 'Authentication' })).toBeTruthy();
		expect(screen.getByLabelText(/API key/)).toBeTruthy();
		const advanced = screen.getByRole('button', { name: 'Advanced' });
		expect(advanced.getAttribute('aria-expanded')).toBe('false');
		fireEvent.click(advanced);
		expect(screen.getByLabelText(/Headers/).getAttribute('data-slot')).toBe('textarea');
		expect(screen.getByRole('combobox', { name: 'Provider' })).toBeTruthy();
		expect(dialog.querySelector('form')?.noValidate).toBe(true);
		expect(dialog.querySelector('[required]')).toBeNull();
	});

	it('leaves the type choices out where they mean nothing: Ollama and a direct connection', () => {
		renderModal({ ollama: true });
		expect(screen.queryByRole('radiogroup', { name: 'API type' })).toBeNull();
		expect(screen.getByRole('radiogroup', { name: 'Connection type' })).toBeTruthy();
	});

	it('says what Test connection found under the URL: the model count (FBK-1, #1018)', async () => {
		vi.mocked(verifyOpenAIConnection).mockResolvedValue({ data: [{ id: 'a' }, { id: 'b' }] });
		renderModal();
		type(url(), 'http://127.0.0.1:4190/v1/');
		fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
		expect(await screen.findByText('Reachable: 2 models')).toBeTruthy();
		expect(vi.mocked(verifyOpenAIConnection).mock.calls[0][1]).toMatchObject({ url: 'http://127.0.0.1:4190/v1' });
	});

	it('says when the server answered with something that is not a model list', async () => {
		// The backend hands back a 200 that is not JSON as a string (S5-D10).
		vi.mocked(verifyOpenAIConnection).mockResolvedValue('<!DOCTYPE html><html></html>');
		renderModal();
		type(url(), 'http://127.0.0.1:4103');
		fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
		await waitFor(() =>
			expect(url()).toHaveAccessibleDescription("Reached the server, but it didn't return a model list.")
		);
		expect(url().getAttribute('aria-invalid')).toBe('true');
	});

	it('says why a test failed under the URL, and marks it invalid', async () => {
		vi.mocked(verifyOpenAIConnection).mockRejectedValue(
			'Connection refused at 127.0.0.1:9. Check that the server is running.'
		);
		renderModal();
		type(url(), 'http://127.0.0.1:9');
		fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
		await waitFor(() => expect(url().getAttribute('aria-invalid')).toBe('true'));
		expect(url()).toHaveAccessibleDescription('Connection refused at 127.0.0.1:9. Check that the server is running.');
	});

	it('checks the URL is http or https before sending anything', async () => {
		renderModal();
		type(url(), 'not a url');
		fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
		await waitFor(() => expect(url().getAttribute('aria-invalid')).toBe('true'));
		expect(url()).toHaveAccessibleDescription('Enter a URL that starts with http:// or https://.');
		expect(verifyOpenAIConnection).not.toHaveBeenCalled();
	});

	it('names the Ollama version it reached, and drops the "Ollama: " prefix from a failure', async () => {
		vi.mocked(verifyOllamaConnection).mockResolvedValueOnce({ version: '0.5.1' });
		renderModal({ ollama: true });
		type(url(), 'http://localhost:11434');
		fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
		expect(await screen.findByText('Reachable: Ollama 0.5.1')).toBeTruthy();
		vi.mocked(verifyOllamaConnection).mockRejectedValueOnce('Ollama: Server Connection Error');
		fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
		await waitFor(() => expect(url()).toHaveAccessibleDescription('Server Connection Error'));
	});

	it('says under the URL that it is missing, focuses it, and does not save', async () => {
		const { onSubmit } = renderModal();
		save();
		await waitFor(() => expect(url().getAttribute('aria-invalid')).toBe('true'));
		expect(url()).toHaveAccessibleDescription('Enter the server’s URL.');
		await waitFor(() => expect(document.activeElement).toBe(url()));
		expect(onSubmit).not.toHaveBeenCalled();
		type(url(), 'h');
		expect(url().getAttribute('aria-invalid')).toBeNull();
	});

	it('opens Advanced to say what Azure needs, under each field in turn', async () => {
		const { onSubmit } = renderModal();
		type(url(), 'https://x.openai.azure.com');
		save();
		const version = await screen.findByLabelText('API version');
		expect(version).toHaveAccessibleDescription('Enter the Azure API version.');
		type(version, '2024-10-21');
		save();
		await waitFor(() =>
			expect(screen.getByLabelText(/API key/)).toHaveAccessibleDescription('Enter the API key. Azure OpenAI needs one.')
		);
		fireEvent.change(screen.getByLabelText(/API key/), { target: { value: 'k' } });
		save();
		await waitFor(() =>
			expect(screen.getByLabelText(/Model IDs/)).toHaveAccessibleDescription(
				'Add a deployment name. Azure OpenAI needs at least one.'
			)
		);
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it('says headers that are not a JSON object under Headers, and does not save', async () => {
		const { onSubmit } = renderModal();
		type(url(), 'https://openrouter.ai/api/v1');
		fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
		type(screen.getByLabelText(/Headers/), '[1]');
		save();
		await waitFor(() =>
			expect(screen.getByLabelText(/Headers/)).toHaveAccessibleDescription(
				'Enter the headers as a JSON object, or leave them empty.'
			)
		);
		// FRM-2: Save takes you to the error, which can be below the fold.
		await waitFor(() => expect(screen.getByLabelText(/Headers/)).toHaveFocus());
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it('saves the choices: Local, Responses, model IDs, and Default as no provider', async () => {
		const { onSubmit, onOpenChange } = renderModal();
		type(url(), 'https://openrouter.ai/api/v1/');
		fireEvent.click(screen.getByRole('radio', { name: 'Local' }));
		fireEvent.click(screen.getByRole('radio', { name: 'Responses' }));
		fireEvent.click(screen.getByRole('switch', { name: 'Enabled' }));
		fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
		const add = screen.getByLabelText(/Model IDs/);
		type(add, 'qwen/qwen3.6-27b');
		fireEvent.keyDown(add, { key: 'Enter' });
		expect(screen.getByText('qwen/qwen3.6-27b')).toBeTruthy();
		// Default's stand-in value never reaches what is saved.
		const provider = screen.getByRole('combobox', { name: 'Provider' });
		expect(provider.textContent).toBe('Default');
		fireEvent.keyDown(provider, { key: 'Enter' });
		fireEvent.click(await screen.findByRole('option', { name: 'LiteLLM' }));
		await waitFor(() => expect(provider.textContent).toBe('LiteLLM'));
		fireEvent.keyDown(provider, { key: 'Enter' });
		fireEvent.click(await screen.findByRole('option', { name: 'Default' }));
		await waitFor(() => expect(provider.textContent).toBe('Default'));
		save();
		await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
		const saved = onSubmit.mock.calls[0][0] as Connection;
		expect(saved.url).toBe('https://openrouter.ai/api/v1');
		expect(saved.config).toMatchObject({
			enable: false,
			connection_type: 'local',
			api_type: 'responses',
			model_ids: ['qwen/qwen3.6-27b']
		});
		expect('provider' in saved.config).toBe(false);
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it('removes a model ID and refuses one already in the list', async () => {
		const { toast } = await import('sonner');
		renderModal({ edit: true, connection: { ...SAVED, config: { ...SAVED.config, model_ids: ['a'] } } });
		fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
		type(screen.getByLabelText(/Model IDs/), 'a');
		fireEvent.click(screen.getByRole('button', { name: 'Add model ID' }));
		expect(toast.error).toHaveBeenCalledWith('“a” is already in the list.');
		fireEvent.click(screen.getByRole('button', { name: 'Remove a' }));
		expect(screen.queryByRole('button', { name: 'Remove a' })).toBeNull();
	});

	it('asks before deleting, naming the URL, destructive (ACT-3)', async () => {
		const { onDelete } = renderModal({ edit: true, connection: SAVED });
		expect(screen.getByRole('heading', { name: 'Edit connection' })).toBeTruthy();
		expect(screen.getByRole('radio', { name: 'Local' }).getAttribute('aria-checked')).toBe('true');
		fireEvent.click(screen.getByRole('button', { name: 'Delete connection' }));
		const ask = await screen.findByRole('alertdialog', { name: 'Delete “http://127.0.0.1:8090/v1”?' });
		expect(ask.textContent).toContain('Its models disappear from the model picker');
		fireEvent.click(within(ask).getByRole('button', { name: 'Delete connection' }));
		await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1));
	});

	it('says what each kind of authentication does, and asks for a key only for Bearer', async () => {
		renderModal();
		const auth = screen.getByRole('combobox', { name: 'Authentication' });
		fireEvent.keyDown(auth, { key: 'Enter' });
		fireEvent.click(await screen.findByRole('option', { name: 'Session' }));
		await waitFor(() => expect(auth).toHaveAccessibleDescription("Sends the signed-in user's session credentials."));
		expect(screen.queryByLabelText(/API key/)).toBeNull();
	});

	it('stays open with what was entered when the save is refused', async () => {
		const onSubmit = vi.fn(async () => {
			throw new Error('refused');
		});
		const { onOpenChange } = renderModal({ onSubmit });
		type(url(), 'https://openrouter.ai/api/v1');
		save();
		await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
		expect(onOpenChange).not.toHaveBeenCalledWith(false);
		expect(url()).toHaveValue('https://openrouter.ai/api/v1');
	});
});

describe('Closing the connection dialog with unsaved changes (FRM-3)', () => {
	it('closes at once while untouched; after an edit Escape asks, Keep editing returns to the field', async () => {
		const onOpenChange = vi.fn();
		renderModal({ edit: true, connection: SAVED, onOpenChange });
		fireEvent.click(screen.getByRole('button', { name: 'Close' }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
		onOpenChange.mockClear();

		type(url(), 'http://127.0.0.1:9000/v1');
		url().focus();
		fireEvent.keyDown(url(), { key: 'Escape' });
		const ask = await screen.findByRole('alertdialog', { name: 'Discard changes?' });
		expect(ask).toHaveTextContent('The changes to this connection are not saved.');
		fireEvent.click(within(ask).getByRole('button', { name: 'Keep editing' }));
		await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
		await waitFor(() => expect(document.activeElement).toBe(url()));
		expect(onOpenChange).not.toHaveBeenCalled();
		expect(url()).toHaveValue('http://127.0.0.1:9000/v1');

		fireEvent.click(screen.getByRole('button', { name: 'Close' }));
		fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard changes' }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it('asks for an added connection too, counting a model id typed but not added', async () => {
		const onOpenChange = vi.fn();
		renderModal({ onOpenChange });
		fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
		type(screen.getByPlaceholderText('Add a model ID'), 'qwen');
		fireEvent.click(screen.getByRole('button', { name: 'Close' }));
		const ask = await screen.findByRole('alertdialog', { name: 'Discard changes?' });
		expect(ask).toHaveTextContent('This connection is not added yet.');
		expect(onOpenChange).not.toHaveBeenCalled();
	});

	it('closes without asking once the edit is saved', async () => {
		const onSubmit = vi.fn().mockResolvedValue(undefined);
		const onOpenChange = vi.fn();
		renderModal({ edit: true, connection: SAVED, onSubmit, onOpenChange });
		type(url(), 'http://127.0.0.1:9000/v1');
		save();
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
		expect(screen.queryByRole('alertdialog')).toBeNull();
	});
});

describe('A tall connection dialog (OVL-1)', () => {
	it('scrolls its fields in DialogBody while the title and Save stay pinned', () => {
		renderModal();
		fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
		const body = document.querySelector('[data-slot="dialog-body"]') as HTMLElement;
		expect(body).toContainElement(url());
		expect(body).not.toContainElement(screen.getByRole('button', { name: 'Save' }));
		expect(body.parentElement?.tagName).toBe('FORM');
		expect(body.parentElement?.parentElement).toHaveAttribute('data-slot', 'dialog-content');
	});
});
