import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getToolServerData } from '@/lib/apis';
import { initiateOAuthRedirect, registerOAuthClient, verifyToolServerConnection } from '@/lib/apis/configs';
import { useAuthStore } from '@/lib/stores/authStore';
import { AddToolServerModal } from './AddToolServerModal';
import type { ToolServerConnection } from './toolServerModel';

vi.mock('file-saver', () => ({ default: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/apis', () => ({ getToolServerData: vi.fn() }));
vi.mock('@/lib/apis/configs', () => ({
	initiateOAuthRedirect: vi.fn(),
	registerOAuthClient: vi.fn(),
	verifyToolServerConnection: vi.fn()
}));

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

function renderModal(props: Partial<Parameters<typeof AddToolServerModal>[0]> = {}) {
	const onSubmit = vi.fn();
	const onDelete = vi.fn();
	render(
		<TooltipProvider>
			<AddToolServerModal open onOpenChange={vi.fn()} onSubmit={onSubmit} onDelete={onDelete} {...props} />
		</TooltipProvider>
	);
	return { onSubmit, onDelete };
}

const url = () => screen.getByLabelText('URL');
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save' }));
const chooseAuth = async (name: string) => {
	fireEvent.keyDown(screen.getByRole('combobox', { name: 'Authentication' }), { key: 'Enter' });
	fireEvent.click(await screen.findByRole('option', { name }));
};

describe('AddToolServerModal (#933)', () => {
	it('is titled "Add tool server" and labels every field on the shared controls', () => {
		renderModal();
		expect(screen.getByRole('heading', { name: 'Add tool server' })).toBeTruthy();
		expect(screen.getByRole('radiogroup', { name: 'Server type' })).toBeTruthy();
		for (const name of [/^Name/, /^ID/, /^Description/]) {
			expect(screen.getByLabelText(name).getAttribute('data-slot')).toBe('input');
		}
		expect(url().getAttribute('data-slot')).toBe('input');
		expect(screen.getByRole('switch', { name: 'Enabled' })).toBeTruthy();
		expect(screen.getByRole('combobox', { name: 'Authentication' })).toBeTruthy();
		expect(screen.getByLabelText(/API key/)).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Advanced' }).getAttribute('aria-expanded')).toBe('false');
		expect(document.querySelector('form')?.noValidate).toBe(true);
		expect(screen.queryByText(/Open WebUI/)).toBeNull();
	});

	it('tests the connection and says under the URL what it found', async () => {
		vi.mocked(verifyToolServerConnection).mockResolvedValueOnce({} as never);
		renderModal();
		type(url(), 'https://tools.example.com');
		fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
		expect(await screen.findByText('Reachable')).toBeTruthy();
		vi.mocked(verifyToolServerConnection).mockRejectedValueOnce('Connection refused at tools.example.com:443.');
		fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
		await waitFor(() => expect(url()).toHaveAccessibleDescription('Connection refused at tools.example.com:443.'));
		expect(url().getAttribute('aria-invalid')).toBe('true');
	});

	it('checks the URL before a test, and reads the spec from the browser for a direct server', async () => {
		vi.mocked(getToolServerData).mockResolvedValueOnce({} as never);
		renderModal({ direct: true });
		expect(screen.queryByRole('radiogroup', { name: 'Server type' })).toBeNull();
		expect(screen.queryByLabelText(/^ID/)).toBeNull();
		fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
		await waitFor(() => expect(url()).toHaveAccessibleDescription('Enter the server’s URL.'));
		type(url(), 'https://tools.example.com');
		fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
		expect(await screen.findByText('Reachable: the spec loaded')).toBeTruthy();
		expect(getToolServerData).toHaveBeenCalledWith('', 'https://tools.example.com/openapi.json');
	});

	it('says what is wrong under the field at fault, and does not save', async () => {
		const { onSubmit } = renderModal();
		save();
		await waitFor(() => expect(url()).toHaveAccessibleDescription('Enter the server’s URL.'));
		type(url(), 'https://tools.example.com/');
		type(screen.getByLabelText(/^ID/), 'a:b');
		save();
		await waitFor(() =>
			expect(screen.getByLabelText(/^ID/)).toHaveAccessibleDescription('An ID can’t contain “:” or “|”.')
		);
		type(screen.getByLabelText(/^ID/), 'tools');
		fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
		type(screen.getByLabelText(/Headers/), 'nope');
		save();
		await waitFor(() =>
			expect(screen.getByLabelText(/Headers/)).toHaveAccessibleDescription(
				'Enter the headers as a JSON object, or leave them empty.'
			)
		);
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it('opens Advanced to ask for the spec path, and takes a JSON spec instead', async () => {
		const { onSubmit } = renderModal();
		type(url(), 'https://tools.example.com/');
		fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
		const path = screen.getByLabelText('Spec path or URL');
		expect(path).toHaveAccessibleDescription('local-llm sends requests to https://tools.example.com/openapi.json');
		type(path, '');
		save();
		await waitFor(() =>
			expect(screen.getByLabelText('Spec path or URL')).toHaveAccessibleDescription(
				'Enter the path or URL of the OpenAPI spec.'
			)
		);
		fireEvent.click(screen.getByRole('radio', { name: 'JSON' }));
		type(screen.getByLabelText('Spec'), '{');
		save();
		await waitFor(() => expect(screen.getByLabelText('Spec')).toHaveAccessibleDescription('Enter the spec as JSON.'));
		type(screen.getByLabelText('Spec'), '{"openapi":"3.1.0"}');
		save();
		await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
		expect(onSubmit.mock.calls[0][0]).toMatchObject({ url: 'https://tools.example.com', spec_type: 'json' });
	});

	it('warns that MCP is experimental, needs an ID, and needs a registered OAuth 2.1 client', async () => {
		vi.mocked(registerOAuthClient).mockResolvedValueOnce({ oauth_client_info: { client_id: 'c' } } as never);
		const { onSubmit } = renderModal();
		fireEvent.click(screen.getByRole('radio', { name: 'MCP' }));
		expect(screen.getByText(/support is experimental/)).toBeTruthy();
		type(url(), 'https://mcp.example.com/');
		save();
		await waitFor(() =>
			expect(screen.getByLabelText(/^ID/)).toHaveAccessibleDescription('Enter an ID. An MCP server needs one.')
		);
		await chooseAuth('OAuth 2.1');
		expect(screen.getByText('Not registered')).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Check OAuth discovery' })).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Register client' }));
		expect(await screen.findByText('Enter an ID first. Registration needs one.')).toBeTruthy();
		type(screen.getByLabelText(/^ID/), 'mcp1');
		save();
		await waitFor(() =>
			expect(screen.getByRole('combobox', { name: 'Authentication' })).toHaveAccessibleDescription(
				'Register the OAuth client first.'
			)
		);
		fireEvent.click(screen.getByRole('button', { name: 'Register client' }));
		expect(await screen.findByText('Registered')).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Authorize' })).toBeDisabled();
		save();
		await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
		expect(onSubmit.mock.calls[0][0]).toMatchObject({ type: 'mcp', url: 'https://mcp.example.com/' });
	});

	it('asks for a static client, says a refused registration, and authorizes a saved one', async () => {
		vi.mocked(registerOAuthClient).mockRejectedValueOnce('Bad client');
		renderModal({
			edit: true,
			connection: {
				type: 'mcp',
				url: 'https://mcp.example.com/',
				auth_type: 'oauth_2.1_static',
				info: { id: 'mcp1', name: 'Docs', oauth_client_info: { client_id: 'c' } }
			} as ToolServerConnection
		});
		expect(screen.getByRole('heading', { name: 'Edit tool server' })).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Register again' }));
		expect(await screen.findByText('Enter the client ID and client secret first.')).toBeTruthy();
		fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: 'id' } });
		fireEvent.change(screen.getByLabelText('Client secret'), { target: { value: 'secret' } });
		fireEvent.click(screen.getByRole('button', { name: 'Register again' }));
		expect(await screen.findByText("Couldn't register the client. Bad client")).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Authorize' }));
		expect(initiateOAuthRedirect).toHaveBeenCalledWith({ id: 'server:mcp:mcp1', serverId: 'mcp1', authType: 'mcp' });
	});

	it('asks before deleting, naming the server, destructive (ACT-3)', async () => {
		const { onDelete } = renderModal({
			edit: true,
			connection: { type: 'openapi', url: 'https://tools.example.com', info: { id: 't', name: 'Tools' } }
		});
		fireEvent.click(screen.getByRole('button', { name: 'Delete connection' }));
		const ask = await screen.findByRole('alertdialog', { name: 'Delete “Tools”?' });
		expect(ask.textContent).toContain('Its tools stop being offered in chats.');
		fireEvent.click(within(ask).getByRole('button', { name: 'Delete connection' }));
		await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1));
	});

	it('stays open when the save is refused', async () => {
		const onSubmit = vi.fn(async () => {
			throw new Error('refused');
		});
		const onOpenChange = vi.fn();
		render(
			<TooltipProvider>
				<AddToolServerModal open onOpenChange={onOpenChange} onSubmit={onSubmit} />
			</TooltipProvider>
		);
		type(url(), 'https://tools.example.com');
		save();
		await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
		expect(onOpenChange).not.toHaveBeenCalledWith(false);
	});
});

describe('Closing the tool server dialog with unsaved changes (FRM-3)', () => {
	it('closes at once while untouched; after an edit Escape asks, Keep editing returns to the field', async () => {
		const onOpenChange = vi.fn();
		renderModal({ onOpenChange });
		fireEvent.click(screen.getByRole('button', { name: 'Close' }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
		onOpenChange.mockClear();

		type(url(), 'https://tools.example.com');
		url().focus();
		fireEvent.keyDown(url(), { key: 'Escape' });
		const ask = await screen.findByRole('alertdialog', { name: 'Discard changes?' });
		expect(ask).toHaveTextContent('This tool server is not added yet.');
		fireEvent.click(within(ask).getByRole('button', { name: 'Keep editing' }));
		await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
		await waitFor(() => expect(document.activeElement).toBe(url()));
		expect(onOpenChange).not.toHaveBeenCalled();
		expect(url()).toHaveValue('https://tools.example.com');

		fireEvent.click(screen.getByRole('button', { name: 'Close' }));
		fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard changes' }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it('closes without asking once the server is saved', async () => {
		const onSubmit = vi.fn().mockResolvedValue(undefined);
		const onOpenChange = vi.fn();
		renderModal({ onSubmit, onOpenChange });
		type(url(), 'https://tools.example.com');
		save();
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
		expect(screen.queryByRole('alertdialog')).toBeNull();
	});
});

describe('A tall tool server dialog (OVL-1)', () => {
	it('scrolls its fields in DialogBody while the title and Save stay pinned', () => {
		renderModal();
		const body = document.querySelector('[data-slot="dialog-body"]') as HTMLElement;
		expect(body).toContainElement(url());
		expect(body).not.toContainElement(screen.getByRole('button', { name: 'Save' }));
		expect(body.parentElement?.tagName).toBe('FORM');
		expect(body.parentElement?.parentElement).toHaveAttribute('data-slot', 'dialog-content');
	});
});
