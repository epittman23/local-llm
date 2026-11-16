import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { AutomationResponse } from '@/lib/apis/automations';
import { AutomationDialog, nextRunsText } from './AutomationDialog';

const { getModels, createAutomation, updateAutomationById, destinations, settings } = vi.hoisted(() => ({
	getModels: vi.fn(),
	createAutomation: vi.fn(),
	updateAutomationById: vi.fn(),
	destinations: { folders: [] as unknown[], channels: [] as unknown[], loaded: true },
	settings: { models: [] as string[] }
}));

vi.mock('@/lib/apis', () => ({ getModels }));
vi.mock('@/lib/apis/automations', () => ({ createAutomation, updateAutomationById }));
vi.mock('@/lib/stores/authStore', () => ({
	useAuthStore: (sel: (s: unknown) => unknown) => sel({ token: 't', user: { id: 'me', role: 'user' } })
}));
vi.mock('@/lib/stores/configStore', () => ({
	useConfigStore: (sel: (s: unknown) => unknown) => sel({ config: { default_models: 'm1' } })
}));
vi.mock('@/lib/settings/userSettings', () => ({ useUserSettings: () => ({ settings }) }));
vi.mock('./useDestinations', () => ({ useDestinations: () => destinations }));
// cmdk measures its list, and Radix positions popovers, with APIs jsdom lacks.
vi.stubGlobal(
	'ResizeObserver',
	class {
		observe() {}
		unobserve() {}
		disconnect() {}
	}
);
Element.prototype.scrollIntoView = () => {};

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
	const router = createMemoryRouter(
		[{ path: '/', element: <AutomationDialog open onOpenChange={onOpenChange} onSaved={onSaved} {...props} /> }],
		{ initialEntries: ['/'] }
	);
	render(
		<QueryClientProvider client={new QueryClient()}>
			<TooltipProvider>
				<RouterProvider router={router} />
			</TooltipProvider>
		</QueryClientProvider>
	);
	return { onSaved, onOpenChange };
};

/** Radix's Select keeps a hidden native select inside a form; changing it chooses the frequency. */
const chooseFrequency = (value: string) => {
	const native = document.querySelector('form select[aria-hidden="true"]') as HTMLSelectElement;
	fireEvent.change(native, { target: { value } });
};

beforeEach(() => {
	vi.resetAllMocks();
	getModels.mockResolvedValue([
		{ id: 'm1', name: 'Model One' },
		{ id: 'm2', name: 'Model Two' },
		{ id: 'h', name: 'Hidden', info: { meta: { hidden: true } } }
	]);
	settings.models = [];
	destinations.folders = [{ id: 'f1', name: 'Work' }];
	destinations.channels = [{ id: 'c1', name: 'general', type: 'group', is_member: true }];
});

describe('the dialog (OVL-1, #1033)', () => {
	it('names its action, and starts a new automation on the default model', async () => {
		open();
		expect(screen.getByRole('heading', { name: 'New automation' })).toBeInTheDocument();
		expect(screen.getByLabelText('Name')).toHaveFocus();
		await waitFor(() => expect(screen.getByRole('button', { name: 'Model' })).toHaveTextContent('Model One'));
		expect(screen.getByRole('button', { name: 'Create automation' })).toBeInTheDocument();
	});

	it("prefers the user's own first model", async () => {
		settings.models = ['m2'];
		open();
		await waitFor(() => expect(screen.getByRole('button', { name: 'Model' })).toHaveTextContent('Model Two'));
	});

	it('is titled for editing an automation', () => {
		open({ automation });
		expect(screen.getByRole('heading', { name: 'Edit automation' })).toBeInTheDocument();
		expect(screen.getByLabelText('Name')).toHaveValue('Digest');
	});
});

describe('the schedule (#1032, #1104)', () => {
	it('shows the weekly days as toggles, pressed in the brand fill', () => {
		open({ automation });
		const days = screen.getByRole('group', { name: 'Days' });
		const tue = within(days).getByRole('button', { name: 'Tue' });
		expect(within(days).getByRole('button', { name: 'Mon' })).toHaveAttribute('data-variant', 'default');
		expect(tue).toHaveAttribute('aria-pressed', 'false');
		expect(tue).toHaveAttribute('data-variant', 'outline');
		fireEvent.click(tue);
		expect(tue).toHaveAttribute('aria-pressed', 'true');
		fireEvent.click(tue);
		expect(tue).toHaveAttribute('aria-pressed', 'false');
	});

	it('shows the next runs with the time zone under the schedule', () => {
		open({ automation });
		expect(screen.getByText(/^Next: Mon, .+; Mon, .+; Mon, .+ \(.+\)$/)).toBeInTheDocument();
		expect(nextRunsText('DTSTART:20200101T090000\nRRULE:FREQ=DAILY;COUNT=1')).toBeNull();
	});

	it('refuses a weekly schedule with no day, under the schedule', () => {
		open({ automation });
		fireEvent.click(screen.getByRole('button', { name: 'Mon' }));
		fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
		expect(screen.getByText('Choose at least one day.')).toBeInTheDocument();
		expect(updateAutomationById).not.toHaveBeenCalled();
	});

	it('asks for an interval, a time, a day of the month or a date as the frequency needs', () => {
		open({ automation });
		chooseFrequency('MINUTELY');
		expect(screen.getByLabelText('Every')).toHaveValue(15);
		fireEvent.change(screen.getByLabelText('Every'), { target: { value: '30' } });
		expect(screen.getByText('minutes')).toBeInTheDocument();
		chooseFrequency('HOURLY');
		fireEvent.change(screen.getByLabelText('Minutes past'), { target: { value: '75' } });
		expect(screen.getByLabelText('Minutes past')).toHaveValue(59);
		chooseFrequency('MONTHLY');
		fireEvent.change(screen.getByLabelText('Day'), { target: { value: '12' } });
		fireEvent.change(screen.getByLabelText('At'), { target: { value: '07:45' } });
		expect(screen.getByLabelText('At')).toHaveValue('07:45');
		chooseFrequency('ONCE');
		fireEvent.change(screen.getByLabelText('On'), { target: { value: '2099-01-02' } });
		fireEvent.change(screen.getByLabelText('at'), { target: { value: '08:30' } });
		expect(screen.getByText(/^Next: .+, Jan 2, 8:30 AM/)).toBeInTheDocument();
	});

	it('explains a custom rule, and says what is wrong with one it cannot read', () => {
		open({ automation });
		chooseFrequency('CUSTOM');
		const rule = screen.getByLabelText('Rule');
		expect(rule).toHaveValue('RRULE:FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0');
		expect(screen.getByText(/^An iCalendar rule, for example/)).toBeInTheDocument();
		fireEvent.change(rule, { target: { value: 'RRULE:FREQ' } });
		fireEvent.blur(rule);
		expect(screen.getByText(/^The scheduler can't read this rule/)).toBeInTheDocument();
		expect(rule).toHaveAttribute('aria-invalid', 'true');
	});

	it("puts the server's refusal of the schedule under it, in words", async () => {
		updateAutomationById.mockRejectedValue('Invalid RRULE: not enough values to unpack (expected 2, got 1)');
		open({ automation });
		fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
		expect(await screen.findByText(/^The scheduler can't read this rule/)).toBeInTheDocument();
		expect(screen.queryByText(/not enough values/)).toBeNull();
	});

	it('says why any other save failed, above the buttons', async () => {
		updateAutomationById.mockRejectedValue('Database is locked');
		open({ automation });
		fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
		expect(await screen.findByText("Couldn't save the automation. Database is locked")).toBeInTheDocument();
	});
});

describe('the model picker', () => {
	it('lists visible models, filters by search, picks one and closes', async () => {
		open({ automation });
		fireEvent.click(screen.getByRole('button', { name: 'Model' }));
		expect(await screen.findByRole('option', { name: 'Model Two' })).toBeInTheDocument();
		expect(screen.queryByRole('option', { name: 'Hidden' })).toBeNull();
		fireEvent.change(screen.getByLabelText('Search models'), { target: { value: 'two' } });
		await waitFor(() => expect(screen.queryByRole('option', { name: 'Model One' })).toBeNull());
		fireEvent.click(screen.getByRole('option', { name: 'Model Two' }));
		await waitFor(() => expect(screen.queryByLabelText('Search models')).toBeNull());
		expect(screen.getByRole('button', { name: 'Model' })).toHaveTextContent('Model Two');
	});
});

describe('where runs go (S6-D13)', () => {
	it('offers a chat, a folder or a channel, and closes on a choice', async () => {
		open({ automation });
		const trigger = screen.getByRole('button', { name: 'Post to' });
		fireEvent.click(trigger);
		fireEvent.click(await screen.findByRole('option', { name: 'Work' }));
		expect(trigger).toHaveTextContent('Chat in Work');
		fireEvent.click(trigger);
		fireEvent.click(await screen.findByRole('option', { name: 'general' }));
		expect(trigger).toHaveTextContent('#general');
		expect(screen.queryByLabelText('Same chat every time')).toBeNull();
		fireEvent.click(trigger);
		fireEvent.click(await screen.findByRole('option', { name: /Chat, in no folder/ }));
		expect(trigger).toHaveTextContent('Chat');
	});

	it('marks a channel target with no channel', () => {
		open({
			automation: {
				...automation,
				data: { ...automation.data, target: { type: 'channel', channel_id: 'gone' } }
			} as AutomationResponse
		});
		fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
		expect(screen.getByText('Choose a channel, or post to a chat instead.')).toBeInTheDocument();
	});

	it('saves "Same chat every time" on the chat target', async () => {
		updateAutomationById.mockResolvedValue({});
		open({ automation });
		fireEvent.click(screen.getByLabelText('Same chat every time'));
		fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
		await waitFor(() => expect(updateAutomationById).toHaveBeenCalled());
		expect(updateAutomationById.mock.calls[0][2].data.target).toEqual({ type: 'chat', same_chat: true });
	});
});

describe('saving', () => {
	it('updates an existing automation and closes', async () => {
		updateAutomationById.mockResolvedValue({});
		const { onSaved, onOpenChange } = open({ automation });
		fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
		await waitFor(() => expect(updateAutomationById).toHaveBeenCalledWith('t', 'a1', expect.anything()));
		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(onSaved).toHaveBeenCalledWith('a1');
	});

	it('creates one and hands back its id', async () => {
		createAutomation.mockResolvedValue({ id: 'new-1' });
		const { onSaved } = open();
		fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Reading list' } });
		fireEvent.change(screen.getByLabelText('Instructions'), { target: { value: 'Three papers' } });
		await waitFor(() => expect(screen.getByRole('button', { name: 'Model' })).toHaveTextContent('Model One'));
		fireEvent.click(screen.getByRole('button', { name: 'Create automation' }));
		await waitFor(() => expect(onSaved).toHaveBeenCalledWith('new-1'));
		expect(createAutomation.mock.calls[0][1]).toMatchObject({ name: 'Reading list', data: { model_id: 'm1' } });
	});

	it('marks each missing field under itself and focuses the first (FRM-2)', async () => {
		open();
		fireEvent.click(screen.getByRole('button', { name: 'Create automation' }));
		expect(screen.getByText('Enter a name for the automation.')).toBeInTheDocument();
		expect(screen.getByText('Enter the instructions the model follows on each run.')).toBeInTheDocument();
		expect(screen.getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true');
		await waitFor(() => expect(screen.getByLabelText('Name')).toHaveFocus());
		expect(createAutomation).not.toHaveBeenCalled();
	});

	it('closes at once with nothing changed, and asks first with changes', async () => {
		const { onOpenChange } = open({ automation });
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
		onOpenChange.mockClear();
		fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Digest 2' } });
		fireEvent.click(screen.getByRole('button', { name: 'Close' }));
		expect(await screen.findByText('Discard changes?')).toBeInTheDocument();
		expect(onOpenChange).not.toHaveBeenCalled();
		expect(updateAutomationById).not.toHaveBeenCalled();
	});
});
