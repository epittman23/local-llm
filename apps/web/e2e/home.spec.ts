import type { Page, Route } from '@playwright/test';
import { expect, test } from './test';
import { mockWorkspaceBackend } from './workspace-helpers';

// /home, the start page (#1093): pinned and recent chats, today's calendar and
// quick actions, each list in its four states (STA-1).

const json = (route: Route, body: unknown, status = 200) =>
	route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const now = Math.floor(Date.now() / 1000);
/** Today at a local hour, in nanoseconds (the calendar's unit), computed in the browser's zone. */
const at = (h: number) => {
	const d = new Date();
	d.setHours(h, 0, 0, 0);
	return d.getTime() * 1_000_000;
};

const PINNED = [{ id: 'pin-1', title: 'Course notes outline', updated_at: now - 2 * 86_400 }];
const RECENT = Array.from({ length: 10 }, (_, i) => ({
	id: `chat-${i}`,
	title: `Recent chat ${i}`,
	updated_at: now - (i + 1) * 3600
}));
const EVENTS = [
	{
		id: 'ev-1',
		calendar_id: 'personal',
		title: 'Statistics seminar',
		start_at: at(14),
		end_at: at(15),
		all_day: false,
		location: 'Room 2',
		meta: null,
		attendees: []
	}
];

type Lists = { pinned?: unknown; recent?: unknown; events?: unknown; status?: number };

async function mockHome(page: Page, lists: Lists = {}) {
	await mockWorkspaceBackend(page, { features: { enable_notes: true, enable_calendar: true } });
	const status = lists.status ?? 200;
	await page.route(/\/api\/v1\/chats\/\?/, (r) => {
		const first = new URL(r.request().url()).searchParams.get('page') === '1';
		return json(r, status === 200 ? (first ? (lists.recent ?? RECENT) : []) : { detail: 'Database is locked' }, status);
	});
	await page.route(/\/api\/v1\/chats\/pinned$/, (r) =>
		json(r, status === 200 ? (lists.pinned ?? PINNED) : { detail: 'Database is locked' }, status)
	);
	await page.route(/\/api\/v1\/calendars\/events\?/, (r) =>
		json(r, status === 200 ? (lists.events ?? EVENTS) : { detail: 'Calendar unavailable' }, status)
	);
}

test('home lists pinned then recent chats and today’s events, and opens a chat', async ({ page }) => {
	await mockHome(page);
	await page.goto('/home');
	await expect(page).toHaveTitle('Home · local-llm');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(['Home']);
	const header = page.locator('[data-page-top]');
	await expect(header.getByRole('link', { name: 'New chat' })).toHaveAttribute('href', '/');
	await expect(page.getByRole('list', { name: 'Quick actions' }).getByRole('link')).toHaveText([
		'New note',
		'Calendar'
	]);
	const chats = page.getByRole('region', { name: 'Pinned and recent chats' }).getByRole('button');
	await expect(chats).toHaveCount(1 + 8);
	await expect(chats.first()).toContainText('Course notes outline');
	await expect(chats.first()).toContainText('2 days ago');
	await expect(chats.nth(1)).toContainText('Recent chat 0');
	const today = page.getByRole('region', { name: 'Today' });
	await expect(today.getByRole('button')).toHaveText(['14:00–15:00Statistics seminarRoom 2']);
	await chats.nth(1).click();
	await expect(page).toHaveURL(/\/c\/chat-0$/);
});

test('home says what belongs in each list when it is empty, with the first step', async ({ page }) => {
	await mockHome(page, { pinned: [], recent: [], events: [] });
	await page.goto('/home');
	await expect(
		page.getByText(/^Nothing here yet\. Your pinned chats and your most recent chats outside folders/)
	).toBeVisible();
	await expect(page.getByRole('link', { name: 'Start a chat' })).toHaveAttribute('href', '/');
	await expect(page.getByText('Nothing on your calendar today.')).toBeVisible();
	await page.getByRole('link', { name: 'Open calendar' }).click();
	await expect(page).toHaveURL(/\/calendar$/);
});

test('home shows a failed list in place and loads it again', async ({ page }) => {
	await mockHome(page, { status: 500 });
	await page.goto('/home');
	const chats = page.getByRole('region', { name: 'Pinned and recent chats' });
	const today = page.getByRole('region', { name: 'Today' });
	await expect(chats.getByRole('alert')).toContainText("Couldn't load chats");
	await expect(today.getByRole('alert')).toContainText("Couldn't load today’s calendar");
	await page.unrouteAll({ behavior: 'ignoreErrors' });
	await mockHome(page);
	await chats.getByRole('button', { name: 'Try again' }).click();
	await expect(chats.getByRole('button', { name: /Course notes outline/ })).toBeVisible();
	await today.getByRole('button', { name: 'Try again' }).click();
	await expect(today.getByRole('button', { name: /Statistics seminar/ })).toBeVisible();
});

test('home works from the keyboard and fits a phone', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await mockHome(page);
	await page.goto('/home');
	const search = page.getByRole('button', { name: 'Search chats' });
	await page.locator('[data-page-top]').getByRole('link', { name: 'New chat' }).focus();
	await page.keyboard.press('Tab');
	await expect(search).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(page.getByRole('dialog')).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('dialog')).toBeHidden();
	await expect(search).toBeFocused();
	await expect(page.getByRole('region', { name: 'Pinned and recent chats' }).getByRole('button').first()).toBeVisible();
	// <main> scrolls both ways, so a page too wide for a phone shows up as main's own overflow.
	const overflow = await page.getByRole('main').evaluate((m) => m.scrollWidth - m.clientWidth);
	expect(overflow).toBeLessThanOrEqual(0);
});
