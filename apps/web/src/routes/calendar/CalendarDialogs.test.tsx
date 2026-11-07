import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '@/lib/apis/calendar';
import { EventDialog } from './CalendarDialogs';
import { NS } from './calendarModel';

vi.mock('@/lib/apis/calendar', async (original) => ({
	...(await original<typeof import('@/lib/apis/calendar')>()),
	getCalendarEventById: vi.fn(),
	updateCalendarEvent: vi.fn(),
	createCalendarEvent: vi.fn(),
	deleteCalendarEvent: vi.fn()
}));
const toastError = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { error: toastError, success: vi.fn() } }));

const ns = (d: Date) => d.getTime() * NS;
const calendars = [
	{ id: 'personal', name: 'Personal', color: '#3b82f6', is_default: true, is_system: false }
] as never[];
// The 16 Sep occurrence of a daily standup that began 1 Sep.
const occurrence = {
	id: 's1',
	calendar_id: 'personal',
	user_id: 'u1',
	title: 'Standup',
	start_at: ns(new Date(2026, 8, 16, 9)),
	end_at: ns(new Date(2026, 8, 16, 9, 15)),
	all_day: false,
	rrule: 'FREQ=DAILY',
	meta: null,
	instance_id: 's1_x'
} as never;

const open = () =>
	render(
		<EventDialog
			open
			onOpenChange={() => {}}
			event={occurrence}
			calendars={calendars}
			defaultCalendarId="personal"
			defaultStartAt={null}
			onSaved={() => {}}
		/>
	);

describe('EventDialog on an occurrence of a repeating event (#318)', () => {
	beforeEach(() => {
		vi.mocked(api.updateCalendarEvent).mockResolvedValue(occurrence);
	});
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it('saves the series at its own start, loaded from the server', async () => {
		vi.mocked(api.getCalendarEventById).mockResolvedValue({
			...(occurrence as object),
			start_at: ns(new Date(2026, 8, 1, 9)),
			instance_id: undefined
		} as never);
		open();
		expect(screen.getByText(/changes apply to every occurrence/)).toBeTruthy();
		fireEvent.change(screen.getByLabelText('Event title'), { target: { value: 'Daily standup' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(api.updateCalendarEvent).toHaveBeenCalled());
		expect(api.getCalendarEventById).toHaveBeenCalledWith(expect.anything(), 's1');
		expect(vi.mocked(api.updateCalendarEvent).mock.calls[0][2]).toMatchObject({
			title: 'Daily standup',
			start_at: ns(new Date(2026, 8, 1, 9)),
			end_at: ns(new Date(2026, 8, 1, 9, 15))
		});
	});

	it('saves nothing when the series cannot be loaded', async () => {
		vi.mocked(api.getCalendarEventById).mockRejectedValue('Not found');
		open();
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(toastError).toHaveBeenCalledWith('Not found'));
		expect(api.updateCalendarEvent).not.toHaveBeenCalled();
	});

	it('asks before deleting, saying every occurrence goes', async () => {
		open();
		fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
		expect(await screen.findByText(/deletes every occurrence of this event/)).toBeTruthy();
	});
});

describe('EventDialog reminder (#324)', () => {
	const single = {
		...(occurrence as object),
		id: 'e1',
		rrule: null,
		instance_id: undefined,
		meta: { alert_minutes: 120 }
	} as never;
	beforeEach(() => {
		vi.mocked(api.updateCalendarEvent).mockResolvedValue(single);
	});
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it('shows a reminder that is not one of the choices, keeps it listed, and can turn it off', async () => {
		render(
			<EventDialog
				open
				onOpenChange={() => {}}
				event={single}
				calendars={calendars}
				defaultCalendarId="personal"
				defaultStartAt={null}
				onSaved={() => {}}
			/>
		);
		const reminder = screen.getByLabelText('Reminder') as HTMLSelectElement;
		expect(reminder.value).toBe('120');
		fireEvent.change(reminder, { target: { value: '30' } });
		// The event's own value stays a choice after another is picked.
		expect(screen.getByRole('option', { name: '2 hours before' })).toBeTruthy();
		fireEvent.change(reminder, { target: { value: '-1' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(api.updateCalendarEvent).toHaveBeenCalled());
		expect(vi.mocked(api.updateCalendarEvent).mock.calls[0][2]).toMatchObject({ meta: { alert_minutes: -1 } });
	});
});

describe('EventDialog on an event whose repeat rule the menu cannot show (#510)', () => {
	const biweekly = {
		id: 'b1',
		calendar_id: 'personal',
		user_id: 'u1',
		title: 'Review',
		start_at: ns(new Date(2026, 8, 1, 9)),
		end_at: ns(new Date(2026, 8, 1, 10)),
		all_day: false,
		rrule: 'FREQ=WEEKLY;INTERVAL=2',
		meta: null
	} as never;
	const openBiweekly = () =>
		render(
			<EventDialog
				open
				onOpenChange={() => {}}
				event={biweekly}
				calendars={calendars}
				defaultCalendarId="personal"
				defaultStartAt={null}
				onSaved={() => {}}
			/>
		);
	beforeEach(() => {
		vi.mocked(api.updateCalendarEvent).mockResolvedValue(biweekly);
	});
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it('shows the rule as a custom one, and a save keeps it', async () => {
		openBiweekly();
		const repeat = (await screen.findByLabelText('Repeat')) as HTMLSelectElement;
		expect(repeat.value).toBe('custom');
		expect(repeat.selectedOptions[0].textContent).toBe('Custom rule');

		fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		await waitFor(() => expect(api.updateCalendarEvent).toHaveBeenCalled());
		// Undefined, so the request leaves it out and the update keeps the rule.
		expect(vi.mocked(api.updateCalendarEvent).mock.calls[0][2].rrule).toBeUndefined();
	});

	it('No Repeat clears it', async () => {
		openBiweekly();
		fireEvent.change(await screen.findByLabelText('Repeat'), { target: { value: '' } });

		fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		await waitFor(() => expect(api.updateCalendarEvent).toHaveBeenCalled());
		expect(vi.mocked(api.updateCalendarEvent).mock.calls[0][2]).toMatchObject({ rrule: null });
	});

	it('a new event offers no custom rule', async () => {
		render(
			<EventDialog
				open
				onOpenChange={() => {}}
				event={null}
				calendars={calendars}
				defaultCalendarId="personal"
				defaultStartAt={null}
				onSaved={() => {}}
			/>
		);
		const repeat = (await screen.findByLabelText('Repeat')) as HTMLSelectElement;
		expect([...repeat.options].map((o) => o.value)).not.toContain('custom');
	});
});

describe('EventDialog on an event whose menu rule is stored in another form (#707)', () => {
	const rule = 'DTSTART:20260901T090000\nRRULE:FREQ=DAILY';
	const daily = {
		id: 'd1',
		calendar_id: 'personal',
		user_id: 'u1',
		title: 'Standup',
		start_at: ns(new Date(2026, 8, 1, 9)),
		end_at: ns(new Date(2026, 8, 1, 9, 15)),
		all_day: false,
		rrule: rule,
		meta: null
	} as never;
	beforeEach(() => {
		vi.mocked(api.updateCalendarEvent).mockResolvedValue(daily);
	});
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it('shows it as Daily, and a save keeps the rule as it was stored', async () => {
		render(
			<EventDialog
				open
				onOpenChange={() => {}}
				event={daily}
				calendars={calendars}
				defaultCalendarId="personal"
				defaultStartAt={null}
				onSaved={() => {}}
			/>
		);
		const repeat = (await screen.findByLabelText('Repeat')) as HTMLSelectElement;
		expect(repeat.value).toBe('daily');
		expect([...repeat.options].map((o) => o.value)).not.toContain('custom');

		fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		await waitFor(() => expect(api.updateCalendarEvent).toHaveBeenCalled());
		expect(vi.mocked(api.updateCalendarEvent).mock.calls[0][2].rrule).toBe(rule);
	});
});
