import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import * as api from '@/lib/apis/calendar';
import { CalendarDialog, EventDialog } from './CalendarDialogs';
import { NS } from './calendarModel';

vi.mock('@/lib/apis/calendar', async (original) => ({
	...(await original<typeof import('@/lib/apis/calendar')>()),
	getCalendarEventById: vi.fn(),
	updateCalendarEvent: vi.fn(),
	createCalendarEvent: vi.fn(),
	deleteCalendarEvent: vi.fn(),
	createCalendar: vi.fn(),
	updateCalendar: vi.fn()
}));
const toastError = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { error: toastError, success: vi.fn() } }));

const ns = (d: Date) => d.getTime() * NS;

// Radix's Select asks for these, which jsdom lacks.
beforeAll(() => {
	Element.prototype.hasPointerCapture ??= () => false;
	Element.prototype.scrollIntoView ??= () => {};
});

/** Opens the shared Select named `label` and chooses `option`, from the keyboard. */
const choose = async (label: string, option: string) => {
	fireEvent.keyDown(screen.getByRole('combobox', { name: label }), { key: 'Enter' });
	fireEvent.keyDown(await screen.findByRole('option', { name: option }), { key: 'Enter' });
};
const chosen = (label: string) => screen.getByRole('combobox', { name: label }).textContent;
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
		fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Daily standup' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save event' }));
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
		fireEvent.click(screen.getByRole('button', { name: 'Save event' }));
		await waitFor(() => expect(toastError).toHaveBeenCalledWith('Couldn’t save the event', expect.anything()));
		expect(api.updateCalendarEvent).not.toHaveBeenCalled();
	});

	it('asks before deleting, saying every occurrence goes', async () => {
		open();
		fireEvent.click(screen.getByRole('button', { name: 'Delete event' }));
		expect(await screen.findByText(/deletes every occurrence of “Standup”/)).toBeTruthy();
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
		expect(chosen('Reminder')).toBe('2 hours before');
		await choose('Reminder', '30 minutes before');
		expect(chosen('Reminder')).toBe('30 minutes before');
		// The event's own value stays a choice after another is picked.
		fireEvent.keyDown(screen.getByRole('combobox', { name: 'Reminder' }), { key: 'Enter' });
		expect(await screen.findByRole('option', { name: '2 hours before' })).toBeTruthy();
		fireEvent.keyDown(screen.getByRole('option', { name: 'None' }), { key: 'Enter' });
		fireEvent.click(screen.getByRole('button', { name: 'Save event' }));
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
		expect(chosen('Repeat')).toBe('Custom rule');

		fireEvent.click(screen.getByRole('button', { name: 'Save event' }));

		await waitFor(() => expect(api.updateCalendarEvent).toHaveBeenCalled());
		// Undefined, so the request leaves it out and the update keeps the rule.
		expect(vi.mocked(api.updateCalendarEvent).mock.calls[0][2].rrule).toBeUndefined();
	});

	it('No Repeat clears it', async () => {
		openBiweekly();
		await choose('Repeat', 'No repeat');

		fireEvent.click(screen.getByRole('button', { name: 'Save event' }));

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
		fireEvent.keyDown(screen.getByRole('combobox', { name: 'Repeat' }), { key: 'Enter' });
		expect((await screen.findAllByRole('option')).map((o) => o.textContent)).not.toContain('Custom rule');
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
		expect(chosen('Repeat')).toBe('Daily');

		fireEvent.click(screen.getByRole('button', { name: 'Save event' }));

		await waitFor(() => expect(api.updateCalendarEvent).toHaveBeenCalled());
		expect(vi.mocked(api.updateCalendarEvent).mock.calls[0][2].rrule).toBe(rule);
	});
});

describe('EventDialog fields (#966, #1105)', () => {
	const renderNew = (startAt: number | null = ns(new Date(2026, 8, 1, 10))) =>
		render(
			<EventDialog
				open
				onOpenChange={() => {}}
				event={null}
				calendars={calendars}
				defaultCalendarId="personal"
				defaultStartAt={startAt}
				onSaved={() => {}}
			/>
		);
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it('has a visible title, and moving the start moves the end with it', () => {
		renderNew();
		expect(screen.getByRole('heading', { name: 'New event' })).toBeVisible();
		fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '14:00' } });
		expect(screen.getByLabelText('End time')).toHaveValue('15:00');
		fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-09-03' } });
		expect(screen.getByLabelText('End date')).toHaveValue('2026-09-03');
	});

	it('marks an end before the start under the field, and saves nothing (FRM-2)', async () => {
		renderNew();
		fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Review' } });
		fireEvent.change(screen.getByLabelText('End time'), { target: { value: '08:00' } });
		fireEvent.blur(screen.getByLabelText('End time'));
		expect(await screen.findByText('End must be after start')).toBeVisible();
		expect(screen.getByLabelText('End date')).toHaveAttribute('aria-invalid', 'true');
		fireEvent.click(screen.getByRole('button', { name: 'Create event' }));
		expect(api.createCalendarEvent).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(screen.getByLabelText('End date'));
	});

	it('marks a missing title, and creates the event once it is given', async () => {
		vi.mocked(api.createCalendarEvent).mockResolvedValue({ id: 'n' } as never);
		renderNew();
		fireEvent.click(screen.getByRole('button', { name: 'Create event' }));
		expect(await screen.findByText('Enter a title')).toBeVisible();
		fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Review' } });
		fireEvent.click(screen.getByLabelText('All day', { selector: 'button' }));
		expect(screen.queryByLabelText('Start time')).toBeNull();
		fireEvent.click(screen.getByRole('button', { name: 'Create event' }));
		await waitFor(() => expect(api.createCalendarEvent).toHaveBeenCalled());
		expect(vi.mocked(api.createCalendarEvent).mock.calls[0][1]).toMatchObject({
			title: 'Review',
			all_day: true,
			start_at: ns(new Date(2026, 8, 1))
		});
	});

	it('says when a create fails', async () => {
		vi.mocked(api.createCalendarEvent).mockRejectedValue('boom');
		renderNew();
		fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Review' } });
		await choose('Calendar', 'Personal');
		fireEvent.click(screen.getByRole('button', { name: 'Create event' }));
		await waitFor(() => expect(toastError).toHaveBeenCalledWith('Couldn’t create the event', expect.anything()));
	});
});

describe('CalendarDialog colour presets', () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it('offers the six series tokens, starts on the first one free, marks the chosen preset as pressed and saves it', async () => {
		vi.mocked(api.createCalendar).mockResolvedValue({ id: 'n' } as never);
		const onSaved = vi.fn();
		render(<CalendarDialog open onOpenChange={() => {}} calendars={calendars} onSaved={onSaved} />, {
			wrapper: TooltipProvider
		});
		expect(screen.getByRole('heading', { name: 'New calendar' })).toBeVisible();
		// No stylesheet here, so the presets are the dark theme's series values (lib/ui/tokenColour.ts).
		// Six presets, then Custom colour.
		expect(document.querySelectorAll('button[aria-pressed]')).toHaveLength(7);
		// Personal is blue (#3b82f6), so a new calendar starts on yellow (#1106).
		const yellow = screen.getByRole('button', { name: 'Yellow' });
		const green = screen.getByRole('button', { name: 'Green' });
		expect(yellow).toHaveAttribute('aria-pressed', 'true');
		expect(green).toHaveAttribute('aria-pressed', 'false');
		fireEvent.click(green);
		expect(green).toHaveAttribute('aria-pressed', 'true');
		expect(yellow).toHaveAttribute('aria-pressed', 'false');
		fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Gym' } });
		fireEvent.click(screen.getByRole('button', { name: 'Create calendar' }));
		await waitFor(() =>
			expect(api.createCalendar).toHaveBeenCalledWith(expect.anything(), { name: 'Gym', color: '#83d494' })
		);
		expect(onSaved).toHaveBeenCalled();
	});

	it('takes the presets from the current theme each time it opens (#989, D1b)', async () => {
		vi.mocked(api.createCalendar).mockResolvedValue({ id: 'n' } as never);
		document.documentElement.style.setProperty('--series-1', 'oklch(0.48 0.115 245)');
		try {
			render(<CalendarDialog open onOpenChange={() => {}} calendars={[]} onSaved={() => {}} />, {
				wrapper: TooltipProvider
			});
			expect(screen.getByRole('button', { name: 'Blue' })).toHaveAttribute('aria-pressed', 'true');
			fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Work' } });
			fireEvent.click(screen.getByRole('button', { name: 'Create calendar' }));
			await waitFor(() =>
				expect(api.createCalendar).toHaveBeenCalledWith(expect.anything(), { name: 'Work', color: '#0e629a' })
			);
		} finally {
			document.documentElement.removeAttribute('style');
		}
	});

	it('refuses an empty name under the field', () => {
		render(<CalendarDialog open onOpenChange={() => {}} calendars={[]} onSaved={() => {}} />, {
			wrapper: TooltipProvider
		});
		fireEvent.click(screen.getByRole('button', { name: 'Create calendar' }));
		expect(screen.getByText('Enter a name for the calendar')).toBeVisible();
		expect(screen.getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true');
		fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'G' } });
		expect(screen.queryByText('Enter a name for the calendar')).toBeNull();
		expect(api.createCalendar).not.toHaveBeenCalled();
	});

	it('edits a calendar: its name and colour, saved with the update (#1106)', async () => {
		vi.mocked(api.updateCalendar).mockResolvedValue({ id: 'work' } as never);
		const work = { id: 'work', name: 'Work', color: '#eb9a75', is_default: false, is_system: false } as never;
		render(<CalendarDialog open onOpenChange={() => {}} calendar={work} calendars={calendars} onSaved={() => {}} />, {
			wrapper: TooltipProvider
		});
		expect(screen.getByRole('heading', { name: 'Edit calendar' })).toBeVisible();
		expect(screen.getByLabelText('Name')).toHaveValue('Work');
		expect(screen.getByRole('button', { name: 'Orange' })).toHaveAttribute('aria-pressed', 'true');
		fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Office' } });
		// A control of its own: a palette, not a copy of the chosen preset, until a custom colour is picked.
		const customButton = screen.getByRole('button', { name: 'Custom colour' });
		expect(customButton).toHaveAttribute('aria-pressed', 'false');
		expect(customButton.style.backgroundColor).toBe('');
		const picker = screen.getByTestId('custom-colour-input') as HTMLInputElement;
		const showPicker = vi.fn();
		Object.assign(picker, { showPicker });
		fireEvent.click(customButton);
		expect(showPicker).toHaveBeenCalled();
		expect(picker.tabIndex).toBe(-1);
		fireEvent.change(picker, { target: { value: '#123456' } });
		expect(customButton).toHaveAttribute('aria-pressed', 'true');
		expect(customButton.style.backgroundColor).toBe('#123456');
		expect(screen.getByRole('button', { name: 'Orange' })).toHaveAttribute('aria-pressed', 'false');
		fireEvent.click(screen.getByRole('button', { name: 'Save calendar' }));
		await waitFor(() =>
			expect(api.updateCalendar).toHaveBeenCalledWith(expect.anything(), 'work', { name: 'Office', color: '#123456' })
		);
	});

	it('says when a save fails', async () => {
		vi.mocked(api.updateCalendar).mockRejectedValue('nope');
		const work = { id: 'work', name: 'Work', color: null } as never;
		render(<CalendarDialog open onOpenChange={() => {}} calendar={work} calendars={[]} onSaved={() => {}} />, {
			wrapper: TooltipProvider
		});
		fireEvent.click(screen.getByRole('button', { name: 'Save calendar' }));
		await waitFor(() => expect(toastError).toHaveBeenCalledWith('Couldn’t save the calendar', expect.anything()));
	});
});
