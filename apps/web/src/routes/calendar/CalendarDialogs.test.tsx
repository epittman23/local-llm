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
