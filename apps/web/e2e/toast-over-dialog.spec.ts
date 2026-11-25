import type { Page, Route } from '@playwright/test';
import { fakeSocketServer } from './fake-socket';
import { expect, test } from './test';
import { mockWorkspaceBackend } from './workspace-helpers';

// #1133: a modal sets pointer-events: none on <body>, and a press outside its
// content closes it. A toast sits outside the dialog's DOM, so its buttons must
// stay pressable and must not close the dialog.

const json = (route: Route, d: unknown) =>
	route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(d) });
const calendars = [
	{ id: 'personal', name: 'Personal', color: '#3b82f6', is_default: true, is_system: false },
	{ id: 'work', name: 'Work', color: '#ef4444', is_default: false, is_system: false }
];

async function mockCalendar(page: Page) {
	await page.route('**/api/v1/calendars/**', (route) => {
		const path = new URL(route.request().url()).pathname.replace('/api/v1/calendars', '');
		return json(route, route.request().method() === 'GET' && !path.startsWith('/events') ? calendars : []);
	});
}

async function startOn(page: Page, path: string) {
	await mockWorkspaceBackend(page, { features: { enable_calendar: true } });
	await mockCalendar(page);
	const socket = await fakeSocketServer(page);
	await page.goto(path);
	await socket.connected;
	// What utils/automations.py's calendar alert check emits; its toast has an Open action.
	const alert = {
		data: {
			type: 'calendar:alert',
			data: {
				event_id: 'e1',
				title: 'Dentist',
				description: '',
				start_at: new Date('2026-09-15T10:05:00').getTime() * 1_000_000,
				minutes_until: 5,
				calendar_id: 'personal',
				location: ''
			}
		}
	};
	return () => socket.emit('events', alert);
}

const toastOf = (page: Page) => page.locator('[data-sonner-toast]').filter({ hasText: 'Dentist' }).first();

test.beforeEach(async ({ page }) => {
	await page.clock.setFixedTime(new Date('2026-09-15T10:00:00'));
});

test('a toast stays pressable over a dialog: Close dismisses the toast, the dialog stays open', async ({ page }) => {
	const raise = await startOn(page, '/calendar');
	await page.getByRole('button', { name: 'New calendar' }).click();
	const dialog = page.getByRole('dialog', { name: 'New calendar' });
	await expect(dialog).toBeVisible();
	raise();
	await expect(toastOf(page)).toBeVisible();
	await toastOf(page).getByRole('button', { name: 'Close toast' }).click();
	await expect(toastOf(page)).toHaveCount(0);
	await expect(dialog).toBeVisible();
});

test('a toast stays pressable over an alert dialog', async ({ page }) => {
	const raise = await startOn(page, '/calendar');
	await page.getByRole('button', { name: 'More actions for Work' }).click();
	await page.getByRole('menuitem', { name: 'Delete calendar' }).click();
	const ask = page.getByRole('alertdialog');
	await expect(ask).toBeVisible();
	raise();
	await expect(toastOf(page)).toBeVisible();
	await toastOf(page).getByRole('button', { name: 'Close toast' }).click();
	await expect(toastOf(page)).toHaveCount(0);
	await expect(ask).toBeVisible();
});

test('a toast stays pressable over the navigation sheet: its Open action runs, and the sheet stays until the page changes', async ({
	page
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	const raise = await startOn(page, '/workspace/models');
	await page.getByRole('button', { name: 'Open navigation menu' }).click();
	const sheet = page.getByRole('dialog', { name: 'Navigation' });
	await expect(sheet).toBeVisible();
	raise();
	await expect(toastOf(page)).toBeVisible();
	await toastOf(page).getByRole('button', { name: 'Close toast' }).click();
	await expect(toastOf(page)).toHaveCount(0);
	await expect(sheet).toBeVisible();
	raise();
	await toastOf(page).getByRole('button', { name: 'Open' }).click();
	await expect(page).toHaveURL(/\/calendar$/);
});
