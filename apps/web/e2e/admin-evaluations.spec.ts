import type { Page } from '@playwright/test';
import { expect, test } from './test';
import { mockWorkspaceBackend } from './workspace-helpers';

type Rec = Record<string, any>;
type Call = { method: string; path: string; search: string };

const feedback = (n: number, o: Rec = {}): Rec => ({
	id: `fb_${n}`,
	user: { id: 'u1', name: 'Tester' },
	updated_at: 1700000000 + n,
	meta: { chat_id: `chat_${n}`, message_id: 'm2' },
	data: { model_id: `model-${n}`, rating: 1, reason: `Reason ${n}`, comment: `Comment ${n}`, tags: ['helpful'] },
	...o
});

async function mockEvaluationsApi(
	page: Page,
	opts: { models?: Rec[]; entries?: Rec[]; feedbacks?: Rec[]; history?: Rec[] } = {}
) {
	const state = { feedbacks: opts.feedbacks ?? [] };
	const calls: Call[] = [];
	const json = (route: any, d: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(d) });
	await page.route('**/api/models*', (route) => json(route, { data: opts.models ?? [] }));
	await page.route('**/api/v1/evaluations/**', (route) => {
		const req = route.request();
		const url = new URL(req.url());
		const path = url.pathname.replace('/api/v1/evaluations', '');
		calls.push({ method: req.method(), path, search: url.search });
		if (path === '/leaderboard') return json(route, { entries: opts.entries ?? [] });
		if (/^\/leaderboard\/[^/]+\/history$/.test(path)) return json(route, { history: opts.history ?? [] });
		if (path === '/feedbacks/models') return json(route, [...new Set(state.feedbacks.map((f) => f.data?.model_id))]);
		if (path === '/feedbacks/list') {
			const model = url.searchParams.get('model_id');
			const items = state.feedbacks.filter((f) => !model || f.data?.model_id === model);
			return json(route, { items, total: items.length });
		}
		if (path === '/feedbacks/all/export') return json(route, state.feedbacks);
		const m = path.match(/^\/feedback\/([^/]+)$/);
		if (m && req.method() === 'GET') {
			const found = state.feedbacks.find((f) => f.id === m[1]);
			return json(route, {
				...found,
				snapshot: { chat: { chat: { history: { messages: { m1: { content: 'What is 2+2?' }, m2: { content: 'It is 4.', parentId: 'm1' } } } } } }
			});
		}
		if (m && req.method() === 'DELETE') {
			state.feedbacks = state.feedbacks.filter((f) => f.id !== m[1]);
			return json(route, true);
		}
		return json(route, {});
	});
	return { calls };
}

const models = [
	{ id: 'alpha', name: 'Alpha' },
	{ id: 'beta', name: 'Beta' },
	{ id: 'arena-1', name: 'Arena', owned_by: 'arena' }
];
const entries = [
	{ model_id: 'alpha', rating: 1010, won: 3, lost: 1, top_tags: [{ tag: 'code', count: 2 }] },
	{ model_id: 'retired', rating: 1300, won: 9, lost: 1 }
];

test.describe('admin evaluations', () => {
	test('bare /admin/evaluations lands on the Leaderboard, and the tab counts load', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockEvaluationsApi(page, { models, entries, feedbacks: [feedback(1), feedback(2)] });
		await page.goto('/admin/evaluations');
		await expect(page).toHaveURL(/\/admin\/evaluations\/leaderboard$/);
		// alpha + beta (arena hidden) + the retired-but-rated model.
		await expect(page.getByRole('link', { name: /^Leaderboard/ })).toContainText('3');
		await expect(page.getByRole('link', { name: /^Feedback/ })).toContainText('2');
	});

	test('the leaderboard ranks by rating, shows dashes for the unrated, and hides arena models', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockEvaluationsApi(page, { models, entries });
		await page.goto('/admin/evaluations/leaderboard');
		const rows = page.locator('tbody tr');
		await expect(rows).toHaveCount(3);
		await expect(rows.nth(0)).toContainText('retired');
		await expect(rows.nth(0).locator('td').first()).toHaveText('1');
		await expect(rows.nth(1)).toContainText('Alpha');
		await expect(rows.nth(2)).toContainText('Beta');
		await expect(rows.nth(2).locator('td').first()).toHaveText('-');
		await expect(page.getByText('Arena', { exact: true })).toHaveCount(0);
	});

	test('sorting by name keeps each model\'s rank', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockEvaluationsApi(page, { models, entries });
		await page.goto('/admin/evaluations/leaderboard');
		await page.getByRole('columnheader', { name: 'Model' }).click();
		const rows = page.locator('tbody tr');
		await expect(rows.nth(0)).toContainText('Alpha');
		// Alpha is rated second overall, not "1st" because it now sits first.
		await expect(rows.nth(0).locator('td').first()).toHaveText('2');
	});

	test('search goes to the server', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockEvaluationsApi(page, { models, entries });
		await page.goto('/admin/evaluations/leaderboard');
		await expect(page.locator('tbody tr')).toHaveCount(3);
		await page.getByLabel('Search', { exact: true }).fill('alp');
		await expect.poll(() => calls.some((c) => c.path === '/leaderboard' && c.search.includes('query=alp'))).toBe(true);
	});

	test('a row opens the model dialog; changing range re-requests history with the right days', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockEvaluationsApi(page, {
			models,
			entries,
			history: [
				{ date: '2026-09-01', won: 2, lost: 1 },
				{ date: '2026-09-02', won: 1, lost: 0 }
			]
		});
		await page.goto('/admin/evaluations/leaderboard');
		await page.locator('tbody tr', { hasText: 'Alpha' }).click();
		const dialog = page.getByRole('dialog');
		await expect(dialog.getByText('code', { exact: false }).first()).toBeVisible();
		await expect(dialog.getByRole('img', { name: 'Model activity chart' })).toBeVisible();
		await expect.poll(() => calls.some((c) => c.path === '/leaderboard/alpha/history' && c.search.includes('days=30'))).toBe(true);
		await dialog.getByRole('button', { name: '1Y' }).click();
		await expect.poll(() => calls.some((c) => c.path === '/leaderboard/alpha/history' && c.search.includes('days=365'))).toBe(true);
		await dialog.getByRole('button', { name: 'All' }).click();
		await expect.poll(() => calls.some((c) => c.path === '/leaderboard/alpha/history' && c.search.includes('days=0'))).toBe(true);
	});

	test('an empty history says so instead of drawing a chart', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockEvaluationsApi(page, { models, entries, history: [{ date: '2026-09-01', won: 0, lost: 0 }] });
		await page.goto('/admin/evaluations/leaderboard');
		await page.locator('tbody tr', { hasText: 'Alpha' }).click();
		await expect(page.getByRole('dialog').getByText('No activity data')).toBeVisible();
	});
});

test.describe('admin feedback', () => {
	test('lists feedback with result badges, including a numeric draw', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockEvaluationsApi(page, {
			feedbacks: [feedback(1, { data: { model_id: 'model-1', rating: 1 } }), feedback(2, { data: { model_id: 'model-2', rating: 0 } }), feedback(3, { data: { model_id: 'model-3', rating: -1 } })]
		});
		await page.goto('/admin/evaluations/feedback');
		await expect(page.getByText('model-1', { exact: true })).toBeVisible();
		await expect(page.locator('tbody').getByText('Won', { exact: true })).toBeVisible();
		await expect(page.locator('tbody').getByText('Draw', { exact: true })).toBeVisible();
		await expect(page.locator('tbody').getByText('Lost', { exact: true })).toBeVisible();
	});

	test('shows sibling models for an arena feedback, truncated after two', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockEvaluationsApi(page, { feedbacks: [feedback(1, { data: { model_id: 'winner', rating: 1, sibling_model_ids: ['a', 'b', 'c', 'd'] } })] });
		await page.goto('/admin/evaluations/feedback');
		await expect(page.getByText('a, b, and 2 more')).toBeVisible();
	});

	test('the model filter re-queries and resets to page 1', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockEvaluationsApi(page, { feedbacks: [feedback(1), feedback(2)] });
		await page.goto('/admin/evaluations/feedback');
		await page.getByRole('button', { name: 'Model' }).click();
		await page.getByRole('menuitemradio', { name: 'model-2' }).click();
		await expect.poll(() => calls.some((c) => c.path === '/feedbacks/list' && c.search.includes('model_id=model-2'))).toBe(true);
		await expect(page.getByText('model-1', { exact: true })).toHaveCount(0);
	});

	test('a row opens the details with the prompt and response from the snapshot', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockEvaluationsApi(page, { feedbacks: [feedback(1)] });
		await page.goto('/admin/evaluations/feedback');
		await page.locator('tbody tr').first().click();
		const dialog = page.getByRole('dialog');
		await expect(dialog.getByText('What is 2+2?')).toBeVisible();
		await expect(dialog.getByText('It is 4.')).toBeVisible();
		await expect(dialog.getByText('Reason 1')).toBeVisible();
		await expect(dialog.getByText('helpful')).toBeVisible();
		await expect(dialog.getByRole('link', { name: 'chat_1' })).toHaveAttribute('href', /\/s\/chat_1$/);
	});

	test('a feedback with no chat snapshot still opens', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockEvaluationsApi(page, { feedbacks: [feedback(1)] });
		await page.route('**/api/v1/evaluations/feedback/fb_1', (route) => route.fulfill({ json: { id: 'fb_1', meta: {}, snapshot: null } }));
		await page.goto('/admin/evaluations/feedback');
		await page.locator('tbody tr').first().click();
		const dialog = page.getByRole('dialog');
		await expect(dialog.getByText('Feedback Details')).toBeVisible();
		await expect(dialog.getByText('Prompt', { exact: true })).toHaveCount(0);
	});

	test('delete removes the row', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockEvaluationsApi(page, { feedbacks: [feedback(1)] });
		await page.goto('/admin/evaluations/feedback');
		await page.getByRole('button', { name: 'Feedback Menu' }).click();
		await page.getByRole('menuitem', { name: 'Delete' }).click();
		await expect.poll(() => calls.some((c) => c.method === 'DELETE' && c.path === '/feedback/fb_1')).toBe(true);
		await expect(page.getByText('No feedback found')).toBeVisible();
	});

	test('export offers JSON and CSV', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockEvaluationsApi(page, { feedbacks: [feedback(1)] });
		await page.goto('/admin/evaluations/feedback');
		await page.getByRole('button', { name: 'Export' }).click();
		const download = page.waitForEvent('download');
		await page.getByRole('menuitem', { name: 'Export as CSV' }).click();
		expect((await download).suggestedFilename()).toMatch(/^feedback-history-export-\d+\.csv$/);
		expect(calls.some((c) => c.path === '/feedbacks/all/export')).toBe(true);
	});
});
