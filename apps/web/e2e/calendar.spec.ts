import type { Page } from '@playwright/test';
import { expect, test } from './test';
import { mockWorkspaceBackend } from './workspace-helpers';

type Rec = Record<string, any>;
const json = (route: any, d: unknown, status = 200) =>
	route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(d) });
const NS = 1_000_000;
const ns = (iso: string) => new Date(iso).getTime() * NS;

const calendars = [
	{ id: 'personal', name: 'Personal', color: '#3b82f6', is_default: true, is_system: false },
	{ id: 'work', name: 'Work', color: '#ef4444', is_default: false, is_system: false },
	{ id: '__scheduled_tasks__', name: 'Scheduled Tasks', color: '#888888', is_default: false, is_system: true }
];
const event = (
	id: string,
	calendar_id: string,
	title: string,
	start: string,
	end?: string,
	meta: Rec | null = null
) => ({
	id,
	calendar_id,
	title,
	start_at: ns(start),
	end_at: end ? ns(end) : null,
	all_day: false,
	rrule: null,
	description: null,
	location: null,
	color: null,
	meta,
	attendees: []
});

async function mockCalendar(page: Page, events: Rec[] = []) {
	const seen = {
		eventQueries: [] as string[],
		created: [] as Rec[],
		updated: [] as Rec[],
		calendarsCreated: [] as Rec[],
		deleted: [] as string[]
	};
	await page.route('**/api/v1/calendars/**', async (route) => {
		const req = route.request();
		const url = new URL(req.url());
		const path = url.pathname.replace('/api/v1/calendars', '');
		if (req.method() === 'GET' && path.startsWith('/events')) {
			seen.eventQueries.push(url.search);
			return json(route, events);
		}
		if (req.method() === 'GET') return json(route, calendars);
		if (path === '/events/create') {
			seen.created.push(req.postDataJSON());
			return json(route, { id: 'new', ...req.postDataJSON() });
		}
		if (path.includes('/update')) {
			seen.updated.push(req.postDataJSON());
			return json(route, req.postDataJSON());
		}
		if (path === '/create') {
			seen.calendarsCreated.push(req.postDataJSON());
			return json(route, { id: 'c-new', ...req.postDataJSON() });
		}
		if (req.method() === 'DELETE') {
			seen.deleted.push(path);
			return json(route, true);
		}
		return json(route, true);
	});
	return seen;
}

test.beforeEach(async ({ page }) => {
	await page.clock.setFixedTime(new Date('2026-09-15T10:00:00'));
});

test('without the calendar feature the page sends you home and the sidebar has no link', async ({ page }) => {
	await mockWorkspaceBackend(page, { role: 'user', features: { enable_calendar: true } });
	await mockCalendar(page);
	await page.goto('/calendar');
	await expect(page).toHaveURL(/localhost:5174\/$/);
});

test('shows the month with events, and fetches the six-week window', async ({ page }) => {
	await mockWorkspaceBackend(page, {
		role: 'user',
		features: { enable_calendar: true },
		featurePermissions: { calendar: true }
	});
	const seen = await mockCalendar(page, [
		event('e1', 'personal', 'Dentist', '2026-09-16T09:30:00'),
		event('e2', 'work', 'Offsite', '2026-09-21T09:00:00', '2026-09-23T17:00:00')
	]);
	await page.goto('/calendar');
	await expect(page.getByRole('heading', { name: 'September 2026' })).toBeVisible();
	await expect(page.getByRole('button', { name: /Dentist/ })).toBeVisible();
	// A three-day event is on all three days.
	await expect(page.getByRole('button', { name: /Offsite/ })).toHaveCount(3);
	expect(new URLSearchParams(seen.eventQueries[0]).get('start')).toBe(new Date('2026-08-30T00:00:00').toISOString());
});

test('hiding a calendar hides its events; Next moves a month and fetches again', async ({ page }) => {
	await mockWorkspaceBackend(page, { features: { enable_calendar: true } });
	const seen = await mockCalendar(page, [event('e2', 'work', 'Offsite', '2026-09-21T09:00:00')]);
	await page.goto('/calendar');
	await expect(page.getByRole('button', { name: /Offsite/ })).toBeVisible();
	await page.getByRole('button', { name: 'Work', exact: true }).click();
	await expect(page.getByRole('button', { name: /Offsite/ })).toHaveCount(0);
	await page.getByRole('button', { name: 'Next', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'October 2026' })).toBeVisible();
	await expect.poll(() => seen.eventQueries.length).toBe(2);
});

test('clicking a day creates a 9 AM event in the default calendar; the scheduled-tasks calendar is not offered', async ({
	page
}) => {
	await mockWorkspaceBackend(page, { features: { enable_calendar: true } });
	const seen = await mockCalendar(page);
	await page.goto('/calendar');
	await page.getByRole('button', { name: `New event on ${new Date('2026-09-18T00:00:00').toDateString()}` }).click();
	const d = page.getByRole('dialog', { name: 'New event' });
	await expect(d.getByLabel('Start time')).toHaveValue('09:00');
	await expect(d.getByLabel('End time')).toHaveValue('10:00');
	await expect(d.getByLabel('Calendar')).toHaveValue('personal');
	await expect(d.getByLabel('Calendar').locator('option')).toHaveText(['Personal', 'Work']);
	await d.getByRole('button', { name: 'Create' }).click();
	await expect(page.getByText('Title is required')).toBeVisible();
	await d.getByLabel('Event title').fill(' Standup ');
	await d.getByLabel('Repeat').selectOption('weekdays');
	await d.getByLabel('Reminder').selectOption('30');
	await d.getByRole('button', { name: 'Create' }).click();
	await expect
		.poll(() => seen.created[0])
		.toMatchObject({
			calendar_id: 'personal',
			title: 'Standup',
			start_at: ns('2026-09-18T09:00:00'),
			end_at: ns('2026-09-18T10:00:00'),
			rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
			meta: { alert_minutes: 30 }
		});
});

test('an event opens for editing and saves; an automation run opens its chat instead', async ({ page }) => {
	await mockWorkspaceBackend(page, { features: { enable_calendar: true } });
	const seen = await mockCalendar(page, [
		event('e1', 'personal', 'Dentist', '2026-09-16T09:30:00'),
		event('r1', '__scheduled_tasks__', 'Nightly report', '2026-09-17T02:00:00', undefined, {
			automation_id: 'a1',
			chat_id: 'c9'
		})
	]);
	await page.goto('/calendar');
	await page.getByRole('button', { name: /Dentist/ }).click();
	const d = page.getByRole('dialog', { name: 'Edit event' });
	await expect(d.getByLabel('Event title')).toHaveValue('Dentist');
	await d.getByLabel('Location').fill('Main St');
	await d.getByRole('button', { name: 'Save' }).click();
	await expect
		.poll(() => seen.updated[0])
		.toMatchObject({ title: 'Dentist', location: 'Main St', start_at: ns('2026-09-16T09:30:00') });
	await page.getByRole('button', { name: /Nightly report/ }).click();
	await expect(page).toHaveURL(/\/c\/c9$/);
});

test('a new calendar is created with its color; deleting one asks first', async ({ page }) => {
	await mockWorkspaceBackend(page, { features: { enable_calendar: true } });
	const seen = await mockCalendar(page);
	await page.goto('/calendar');
	await page.getByRole('button', { name: 'New calendar' }).click();
	const d = page.getByRole('dialog', { name: 'New Calendar' });
	await d.getByLabel('Name').fill('Gym');
	await d.getByRole('button', { name: '#22c55e' }).click();
	await d.getByRole('button', { name: 'Create' }).click();
	await expect.poll(() => seen.calendarsCreated[0]).toEqual({ name: 'Gym', color: '#22c55e' });
	await expect(page.getByRole('button', { name: 'Delete calendar Personal' })).toHaveCount(0);
	await page.getByRole('button', { name: 'Delete calendar Work' }).click();
	await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
	await expect.poll(() => seen.deleted).toEqual(['/work/delete']);
});
