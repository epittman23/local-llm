import { render, screen } from '../../../../../apps/web/node_modules/@testing-library/react';
import { describe, it } from 'vitest';
import { EventDialog } from '@/routes/calendar/CalendarDialogs';
import { NS } from '@/routes/calendar/calendarModel';

describe('reminder display', () => {
	it('an event with a 120-minute reminder', () => {
		const start = new Date(2026, 9, 20, 9).getTime() * NS;
		const event: any = { id: 'e', calendar_id: 'c', user_id: 'u', title: 'T', description: null, start_at: start, end_at: start + 3600000 * NS, all_day: false, rrule: null, color: null, location: null, data: null, meta: { alert_minutes: 120 }, is_cancelled: false, attendees: [], created_at: 0, updated_at: 0 };
		render(<EventDialog open onOpenChange={() => {}} event={event} calendars={[{ id: 'c', name: 'Cal', is_default: true } as any]} defaultCalendarId="c" defaultStartAt={null} onSaved={() => {}} />);
		const sel = screen.getByLabelText('Reminder') as HTMLSelectElement;
		console.log('select.value', JSON.stringify(sel.value), 'selectedIndex', sel.selectedIndex, 'shown option', sel.options[sel.selectedIndex]?.textContent);
	});
});
