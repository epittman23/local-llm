import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import Interface from './Interface';

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), toast) }));

const api = vi.hoisted(() => ({
	getTaskConfig: vi.fn(),
	updateTaskConfig: vi.fn(),
	getChatConfig: vi.fn(),
	updateChatConfig: vi.fn()
}));
vi.mock('@/lib/apis', async (orig) => ({
	...(await orig<object>()),
	getModels: vi.fn(async () => []),
	getTaskConfig: api.getTaskConfig,
	updateTaskConfig: api.updateTaskConfig
}));
vi.mock('@/lib/apis/chats', async (orig) => ({
	...(await orig<object>()),
	getChatConfig: api.getChatConfig,
	updateChatConfig: api.updateChatConfig
}));
vi.mock('@/lib/apis/models', async (orig) => ({ ...(await orig<object>()), getBaseModels: vi.fn(async () => []) }));

// The two configs the tab loads, and what the server holds after a save.
const TASK = {
	TASK_MODEL: '',
	ENABLE_TITLE_GENERATION: true,
	TITLE_GENERATION_PROMPT_TEMPLATE: 'stored title prompt',
	TASK_MODEL_PARAMS: {}
};
const CHAT = { ENABLE_TOOL_PERMISSIONS: false, ENABLE_CONTEXT_COMPACTION: false };

beforeEach(() => {
	vi.clearAllMocks();
	useAuthStore.setState({ token: 't' } as never);
	api.getTaskConfig.mockResolvedValue(TASK);
	api.getChatConfig.mockResolvedValue(CHAT);
	api.updateTaskConfig.mockImplementation(async (_t: string, body: object) => body);
	api.updateChatConfig.mockImplementation(async (_t: string, body: object) => body);
});

afterEach(() => vi.restoreAllMocks());

const renderTab = async () => {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<TooltipProvider>
				<Interface />
			</TooltipProvider>
		</QueryClientProvider>
	);
	const prompt = await screen.findByLabelText('Title Generation Prompt');
	return {
		prompt: prompt as HTMLTextAreaElement,
		toolPermissions: screen.getByRole('switch', { name: /Tool Permissions/ }),
		save: () => fireEvent.click(screen.getByRole('button', { name: 'Save' }))
	};
};

describe('Interface: one of its two saves fails (#606)', () => {
	it('says the Chat settings were not saved, and keeps the saved half as the server answered it', async () => {
		api.updateTaskConfig.mockImplementation(async (_t: string, body: object) => ({
			...body,
			TITLE_GENERATION_PROMPT_TEMPLATE: 'as the server stored it'
		}));
		api.updateChatConfig.mockRejectedValue('Could not reach the server');
		const tab = await renderTab();
		fireEvent.change(tab.prompt, { target: { value: 'new title prompt' } });
		fireEvent.click(tab.toolPermissions);
		tab.save();

		await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
		expect(toast.error).toHaveBeenCalledWith(
			'The Tasks and Generation settings were saved, but the Chat settings were not: Could not reach the server'
		);
		expect(toast.success).not.toHaveBeenCalled();
		// The saved half shows what the server holds; the unsaved half keeps the edit, to save again.
		expect(tab.prompt.value).toBe('as the server stored it');
		expect(tab.toolPermissions.getAttribute('aria-checked')).toBe('true');
	});

	it('says the Tasks and Generation settings were not saved, naming the field a 422 refused', async () => {
		// The real helper, so the error is what it throws for FastAPI's 422.
		const { updateTaskConfig } = await vi.importActual<typeof import('@/lib/apis')>('@/lib/apis');
		api.updateTaskConfig.mockImplementation(updateTaskConfig);
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					detail: [{ type: 'string_type', loc: ['body', 'TASK_MODEL'], msg: 'Input should be a valid string' }]
				}),
				{ status: 422 }
			)
		);
		const tab = await renderTab();
		fireEvent.click(tab.toolPermissions);
		tab.save();

		await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
		expect(toast.error).toHaveBeenCalledWith(
			'The Chat settings were saved, but the Tasks and Generation settings were not: TASK_MODEL: Input should be a valid string'
		);
		expect(tab.toolPermissions.getAttribute('aria-checked')).toBe('true');
	});

	it('says nothing was saved when both fail', async () => {
		api.updateTaskConfig.mockRejectedValue('Unauthorized');
		api.updateChatConfig.mockRejectedValue('Unauthorized');
		const tab = await renderTab();
		tab.save();

		await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
		expect(toast.error).toHaveBeenCalledWith('Nothing was saved: Unauthorized');
	});

	it('names each half when both fail for different reasons', async () => {
		api.updateTaskConfig.mockRejectedValue('TASK_MODEL: Field required');
		api.updateChatConfig.mockRejectedValue('Could not reach the server');
		const tab = await renderTab();
		tab.save();

		await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
		expect(toast.error).toHaveBeenCalledWith(
			'Nothing was saved: Tasks and Generation: TASK_MODEL: Field required; Chat: Could not reach the server'
		);
	});

	it('shows what the server holds when a failed half was stored after all', async () => {
		// The write lands, then the answer is lost: reading the half back finds it changed.
		api.updateChatConfig.mockRejectedValue('Could not reach the server');
		const tab = await renderTab();
		api.getChatConfig.mockResolvedValue({ ...CHAT, ENABLE_TOOL_PERMISSIONS: true, ENABLE_CONTEXT_COMPACTION: false });
		fireEvent.click(tab.toolPermissions);
		tab.save();

		await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
		expect(toast.error).toHaveBeenCalledWith(
			'The Tasks and Generation settings were saved. The Chat settings were stored, but the server answered with an error: ' +
				'Could not reach the server. They now show what the server holds.'
		);
		expect(tab.toolPermissions.getAttribute('aria-checked')).toBe('true');
	});

	it('says a failed half may not have been saved when it cannot be read back', async () => {
		api.updateChatConfig.mockRejectedValue('Could not reach the server');
		const tab = await renderTab();
		api.getChatConfig.mockRejectedValue('Could not reach the server');
		fireEvent.click(tab.toolPermissions);
		tab.save();

		await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
		expect(toast.error).toHaveBeenCalledWith(
			'The Tasks and Generation settings were saved. The Chat settings may not have been saved: Could not reach the server. ' +
				'Reopen the tab to see what the server holds.'
		);
		// Kept, to save again.
		expect(tab.toolPermissions.getAttribute('aria-checked')).toBe('true');
	});

	it("tells the chat the saved Chat settings, and not a refused half's edits", async () => {
		const features = () => useConfigStore.getState().config?.features as Record<string, unknown>;
		useConfigStore.setState({ config: { features: { enable_tool_permissions: false } } } as never);
		try {
			api.updateTaskConfig.mockRejectedValue('Unauthorized');
			const tab = await renderTab();
			fireEvent.click(tab.toolPermissions);
			tab.save();
			await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
			expect(features().enable_tool_permissions).toBe(true);

			// The server now holds the first save, and refuses the second.
			api.getChatConfig.mockResolvedValue({ ...CHAT, ENABLE_TOOL_PERMISSIONS: true });
			api.updateTaskConfig.mockImplementation(async (_t: string, body: object) => body);
			api.updateChatConfig.mockRejectedValue('Unauthorized');
			fireEvent.click(tab.toolPermissions);
			tab.save();
			await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(2));
			expect(toast.error).toHaveBeenLastCalledWith(
				'The Tasks and Generation settings were saved, but the Chat settings were not: Unauthorized'
			);
			expect(features().enable_tool_permissions).toBe(true);
		} finally {
			useConfigStore.setState({ config: null } as never);
		}
	});

	it('saves both and says so', async () => {
		const tab = await renderTab();
		tab.save();

		await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Settings saved successfully!'));
		expect(toast.error).not.toHaveBeenCalled();
	});
});
