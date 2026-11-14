import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutomationResponse } from '@/lib/apis/automations';
import { AutomationDialog } from './AutomationDialog';

const { getModels, createAutomation, updateAutomationById, toast, destinations } = vi.hoisted(() => ({
	getModels: vi.fn(),
	createAutomation: vi.fn(),
	updateAutomationById: vi.fn(),
	toast: { error: vi.fn(), success: vi.fn() },
	destinations: { folders: [] as unknown[], channels: [] as unknown[], loaded: true }
}));

vi.mock('sonner', () => ({ toast }));
vi.mock('@/lib/apis', () => ({ getModels }));
vi.mock('@/lib/apis/automations', () => ({ createAutomation, updateAutomationById }));
vi.mock('@/lib/stores/authStore', () => ({
	useAuthStore: (sel: (s: unknown) => unknown) => sel({ token: 't', user: { id: 'me', role: 'user' } })
}));
vi.mock('./useDestinations', () => ({ useDestinations: () => destinations }));

const automation = {
	id: 'a1',
	name: 'Digest',
	folder_id: null,
	is_active: true,
	data: { prompt: 'Summarise', model_id: 'm1', rrule: 'RRULE:FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0' }
} as unknown as AutomationResponse;

const open = (props: Partial<Parameters<typeof AutomationDialog>[0]> = {}) => {
	const onSaved = vi.fn();
	const onOpenChange = vi.fn();
	render(
		<QueryClientProvider client={new QueryClient()}>
			<AutomationDialog open onOpenChange={onOpenChange} onSaved={onSaved} {...props} />
		</QueryClientProvider>
	);
	return { onSaved, onOpenChange };
};

beforeEach(() => {
	vi.resetAllMocks();
	getModels.mockResolvedValue([
		{ id: 'm1', name: 'Model One' },
		{ id: 'm2', name: 'Model Two' },
		{ id: 'h', name: 'Hidden', info: { meta: { hidden: true } } }
	]);
	destinations.folders = [{ id: 'f1', name: 'Work' }];
	destinations.channels = [{ id: 'c1', name: 'general', type: 'group', is_member: true }];
});

describe('the weekly schedule days', () => {
	it('toggles a weekday button and reports it as pressed', () => {
		open({ automation });
		fireEvent.click(screen.getByRole('button', { name: 'Schedule' }));
		const tue = screen.getByRole('button', { name: 'Tu' });
		expect(tue).toHaveAttribute('aria-pressed', 'false');
		fireEvent.click(tue);
		expect(tue).toHaveAttribute('aria-pressed', 'true');
		fireEvent.click(tue);
		expect(tue).toHaveAttribute('aria-pressed', 'false');
	});
});

describe('the model picker', () => {
	it('lists visible models, filters by search and picks one', async () => {
		open({ automation });
		fireEvent.click(screen.getByRole('button', { name: 'Model' }));
		expect(await screen.findByRole('button', { name: 'Model Two' })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Hidden' })).toBeNull();
		fireEvent.change(screen.getByLabelText('Search models'), { target: { value: 'two' } });
		expect(screen.queryByRole('button', { name: 'Model One' })).toBeNull();
		fireEvent.click(screen.getByRole('button', { name: 'Model Two' }));
		await waitFor(() => expect(screen.getByRole('button', { name: 'Model' })).toHaveTextContent('Model Two'));
	});
});

describe('the destination picker', () => {
	it('shows the three destination kinds and resets to a new chat', () => {
		open({ automation });
		fireEvent.click(screen.getByRole('button', { name: 'Destination' }));
		expect(screen.getByRole('button', { name: /In a folder/ })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /In a channel/ })).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: /New chat/ }));
		expect(screen.getByRole('button', { name: 'Destination' })).toHaveTextContent('New chat');
	});

	it('picks a folder from the folders tab and goes back', () => {
		open({ automation });
		fireEvent.click(screen.getByRole('button', { name: 'Destination' }));
		fireEvent.click(screen.getByRole('button', { name: /In a folder/ }));
		fireEvent.click(screen.getByRole('button', { name: 'Work' }));
		expect(screen.getByRole('button', { name: 'Destination' })).toHaveTextContent('Work');
		fireEvent.click(screen.getByRole('button', { name: /‹ Back/ }));
		expect(screen.getByRole('button', { name: /In a channel/ })).toBeInTheDocument();
	});

	it('picks a channel from the channels tab', () => {
		open({ automation });
		fireEvent.click(screen.getByRole('button', { name: 'Destination' }));
		fireEvent.click(screen.getByRole('button', { name: /In a channel/ }));
		fireEvent.click(screen.getByRole('button', { name: '#general' }));
		expect(screen.getByRole('button', { name: 'Destination' })).toHaveTextContent('#general');
	});
});

describe('saving', () => {
	it('updates an existing automation and closes', async () => {
		updateAutomationById.mockResolvedValue({});
		const { onSaved, onOpenChange } = open({ automation });
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(updateAutomationById).toHaveBeenCalledWith('t', 'a1', expect.anything()));
		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(onSaved).toHaveBeenCalledWith('a1');
	});

	it('refuses to create with no title and shows why', () => {
		open();
		fireEvent.click(screen.getByRole('button', { name: 'Create' }));
		expect(toast.error).toHaveBeenCalled();
		expect(createAutomation).not.toHaveBeenCalled();
	});

	it('closes without saving when Cancel is pressed', () => {
		const { onOpenChange } = open({ automation });
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(updateAutomationById).not.toHaveBeenCalled();
	});
});
