import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
	createEventWebhook,
	deleteEventWebhook,
	type EventWebhook,
	getEvents,
	getEventWebhooks,
	updateEventWebhook
} from '@/lib/apis';
import { getGroupInfoById, getGroups } from '@/lib/apis/groups';
import { getUserInfoById, searchUsers } from '@/lib/apis/users';
import { useAuthStore } from '@/lib/stores/authStore';
import { Events } from './Events';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
vi.mock('@/lib/apis', () => ({
	createEventWebhook: vi.fn(),
	deleteEventWebhook: vi.fn(),
	getEvents: vi.fn(),
	getEventWebhooks: vi.fn(),
	updateEventWebhook: vi.fn()
}));
vi.mock('@/lib/apis/groups', () => ({ getGroupInfoById: vi.fn(), getGroups: vi.fn() }));
vi.mock('@/lib/apis/users', () => ({ getUserInfoById: vi.fn(), searchUsers: vi.fn() }));

const HOOK: EventWebhook = {
	id: 'w1',
	name: 'Audit',
	url: 'https://hooks.example.com/a',
	enabled: true,
	events: ['*'],
	targets: null
};

beforeEach(() => {
	vi.clearAllMocks();
	useAuthStore.setState({ token: 'tok' } as never);
	vi.mocked(getEvents).mockResolvedValue({
		schema: 's',
		events: [
			{ event: 'user.created', message: 'A user signed up' },
			{ event: 'chat.deleted', message: 'A chat was deleted' }
		]
	} as never);
	vi.mocked(getEventWebhooks).mockResolvedValue([HOOK] as never);
	vi.mocked(getGroups).mockResolvedValue([{ id: 'g1', name: 'Research' }] as never);
	vi.mocked(getUserInfoById).mockResolvedValue(null as never);
	vi.mocked(getGroupInfoById).mockResolvedValue(null as never);
});

afterEach(() => vi.useRealTimers());

const renderEvents = async () => {
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<TooltipProvider>
				<Events />
			</TooltipProvider>
		</QueryClientProvider>
	);
	await screen.findByTestId('webhook-row');
};

const openAdd = async () => {
	fireEvent.click(screen.getByRole('button', { name: 'Add webhook' }));
	await screen.findByText('Add webhook', { selector: 'h2' });
};

describe('Events webhooks', () => {
	it('lists each webhook with a configure button', async () => {
		await renderEvents();
		expect(screen.getByRole('button', { name: 'Configure Audit' })).toBeTruthy();
	});

	it('opens the edit dialog with a Delete button for an existing webhook', async () => {
		await renderEvents();
		fireEvent.click(screen.getByRole('button', { name: 'Configure Audit' }));
		expect(await screen.findByText('Edit webhook')).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
	});

	it('has no Delete button when adding a webhook', async () => {
		await renderEvents();
		await openAdd();
		expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
	});

	it('confirms before deleting, then deletes the webhook', async () => {
		vi.mocked(deleteEventWebhook).mockResolvedValue(undefined as never);
		await renderEvents();
		fireEvent.click(screen.getByRole('button', { name: 'Configure Audit' }));
		fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
		expect(await screen.findByText('Delete webhook')).toBeTruthy();
		expect(deleteEventWebhook).not.toHaveBeenCalled();
		fireEvent.click(screen.getAllByRole('button', { name: 'Delete' }).at(-1) as HTMLElement);
		await waitFor(() => expect(deleteEventWebhook).toHaveBeenCalledWith('tok', 'w1'));
	});

	it('creates a webhook from the dialog', async () => {
		vi.mocked(createEventWebhook).mockResolvedValue(HOOK as never);
		await renderEvents();
		await openAdd();
		fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Mine' } });
		fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://x.example.com/e' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(createEventWebhook).toHaveBeenCalledTimes(1));
		expect(vi.mocked(createEventWebhook).mock.calls[0][1]).toMatchObject({
			name: 'Mine',
			url: 'https://x.example.com/e'
		});
	});

	it('flips a webhook off with its switch', async () => {
		vi.mocked(updateEventWebhook).mockResolvedValue(HOOK as never);
		await renderEvents();
		fireEvent.click(screen.getByRole('switch', { name: 'Enable Audit' }));
		await waitFor(() => expect(updateEventWebhook).toHaveBeenCalledWith('tok', 'w1', { enabled: false }));
	});

	it('picks a group from the search results as a target', async () => {
		await renderEvents();
		await openAdd();
		fireEvent.change(screen.getByLabelText(/Send events for/), { target: { value: 'selected' } });
		fireEvent.change(screen.getByLabelText('Search users or groups'), { target: { value: 'res' } });
		fireEvent.click(await screen.findByRole('button', { name: /Research\s*Group/ }));
		expect(screen.getByRole('button', { name: 'Remove Research' })).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Remove Research' }));
		expect(screen.queryByRole('button', { name: 'Remove Research' })).toBeNull();
	});

	it('picks a user found by the debounced search as a target', async () => {
		vi.mocked(searchUsers).mockResolvedValue({ users: [{ id: 'u9', name: 'Zed', email: 'zed@example.com' }] } as never);
		await renderEvents();
		await openAdd();
		fireEvent.change(screen.getByLabelText(/Send events for/), { target: { value: 'selected' } });
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		fireEvent.change(screen.getByLabelText('Search users or groups'), { target: { value: 'zed' } });
		await act(async () => {
			await vi.advanceTimersByTimeAsync(300);
		});
		vi.useRealTimers();
		fireEvent.click(await screen.findByRole('button', { name: /Zed.*User/ }));
		expect(screen.getByRole('button', { name: 'Remove Zed' })).toBeTruthy();
	});

	it('adds an event pattern from the Add button', async () => {
		await renderEvents();
		await openAdd();
		fireEvent.click(screen.getByLabelText('All events'));
		fireEvent.change(screen.getByLabelText('Search or add pattern'), { target: { value: 'user.*' } });
		fireEvent.click(screen.getByRole('button', { name: 'Add' }));
		expect(screen.getByRole('button', { name: 'Remove user.*' })).toBeTruthy();
	});
});
