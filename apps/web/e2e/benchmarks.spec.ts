import type { Page } from '@playwright/test';
import { expect, test } from './test';

const adminUser = {
	id: 'admin-user',
	email: 'admin@example.com',
	name: 'Admin User',
	role: 'admin',
	profile_image_url: '',
	expires_at: Math.floor(Date.now() / 1000) + 3600
};

const qwen38Entry = {
	profile: {
		profile_id: 1,
		name: 'qwen38',
		display_name: 'Qwen3.8 dense',
		is_default: true,
		created_at: 1700000000,
		archived_at: null
	},
	version: {
		version_id: 1,
		profile_id: 1,
		version: 1,
		created_at: 1700000000,
		created_by: null,
		note: null,
		arch: 'dense',
		alias: 'qwen38',
		model_path: '/models/qwen38.gguf',
		hf_repo: '',
		hf_pattern: '',
		ctx: 4096,
		threads: 6,
		ngl: 20,
		moe: null,
		override_tensors: null,
		parallel: 1,
		cache_k: 'q8_0',
		cache_v: 'q8_0',
		batch: 512,
		ubatch: 512,
		spec: [],
		samplers: [],
		extra: [],
		reasoning_effort_default: null,
		notes: 'the dense baseline profile'
	}
};
const profileEntries = [qwen38Entry];

test.beforeEach(async ({ page, context }) => {
	await context.addInitScript(() => {
		window.localStorage.setItem('token', 'test-token');
	});
	await page.route('**/api/v1/auths/', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(adminUser) })
	);
	await page.route('**/api/config', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				name: 'local-llm',
				version: 'test',
				features: { enable_benchmarks: true }
			})
		})
	);
	await page.route('**/api/v1/benchmarks/serve/profiles', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ profiles: ['qwen38', 'qwen25c'] })
		})
	);
	await page.route('**/api/v1/benchmarks/serve/check', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ port: 8090, model: null, profile: null, running: false })
		})
	);
	// The list endpoint (query string, no name segment) and a single profile's
	// own GET (`/profiles/{name}`, used when opening Edit) return different
	// shapes -- an array vs. one ProfileEntry -- and matching both under one
	// route pattern is exactly the mistake that crashed ProfilesPanel's Edit
	// button (openEdit destructuring an array's `.version`, which is
	// undefined) while writing this suite. Caught visually, not by a test,
	// which is why this distinction is now load-bearing here rather than
	// convenient.
	await page.route(/\/api\/v1\/benchmarks\/profiles\/\?/, (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(profileEntries) })
	);
	await page.route('**/api/v1/benchmarks/profiles/qwen38', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(qwen38Entry) })
	);
	await page.route('**/api/v1/benchmarks/profiles/qwen38/versions', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify([qwen38Entry.version])
		})
	);
});

test('the Benchmarks gate admits an admin and Serve renders the profile list', async ({ page }) => {
	await page.goto('/benchmarks');

	// Bare /benchmarks redirects to /serve (AppRouter.tsx's index route).
	await expect(page).toHaveURL(/\/benchmarks\/serve$/);
	await expect(page.getByRole('heading', { name: 'Serve' })).toBeVisible();

	// Three comboboxes exist on this page (profile, reasoning effort, spec) --
	// the profile picker is the first one rendered.
	await expect(page.getByRole('combobox').first()).toBeVisible();
	await expect(page.getByText('Stopped', { exact: false })).toBeVisible();
});

test('the Profiles panel lists profiles from the CRUD backend', async ({ page }) => {
	await page.goto('/benchmarks/serve');

	await page.getByRole('button', { name: 'Manage profiles' }).click();
	await expect(page.getByRole('dialog')).toBeVisible();
	await expect(page.getByText('qwen38')).toBeVisible();
	// exact + case-sensitive: without it this also matches the Serve page's
	// own "Default" reasoning/spec <Select> options underneath the dialog.
	await expect(page.getByText('default', { exact: true })).toBeVisible();
});

test('Edit opens a version-history-backed form pre-filled from the current definition', async ({ page }) => {
	await page.goto('/benchmarks/serve');

	await page.getByRole('button', { name: 'Manage profiles' }).click();
	await page.getByRole('button', { name: 'Edit' }).click();

	await expect(page.getByRole('heading', { name: 'New version of qwen38' })).toBeVisible();
	// Scoped to the dialog: Serve's own "ctx" override input is still in the
	// DOM behind it and shares the label text.
	const dialog = page.getByRole('dialog');
	await expect(dialog.getByLabel('model_path')).toHaveValue('/models/qwen38.gguf');
	await expect(dialog.getByLabel('ctx')).toHaveValue('4096');
});

test('History shows the version table for a profile', async ({ page }) => {
	await page.goto('/benchmarks/serve');

	await page.getByRole('button', { name: 'Manage profiles' }).click();
	await page.getByRole('button', { name: 'History' }).click();

	await expect(page.getByRole('heading', { name: 'qwen38 — version history' })).toBeVisible();
	await expect(page.getByRole('cell', { name: 'the dense baseline profile' })).toBeVisible();
});

test('Live shows the empty state when nothing is recording', async ({ page }) => {
	await page.route('**/api/v1/benchmarks/live/', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ run: null, summary: {}, deltas: {}, requests: 0, recent_samples: [], warning: null })
		})
	);

	await page.goto('/benchmarks/live');

	await expect(page.getByRole('heading', { name: 'Live' })).toBeVisible();
	await expect(page.getByText('Nothing is currently being recorded')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Kill' })).not.toBeVisible();
});

test('Live renders an active run and Kill requires AlertDialog confirmation', async ({ page }) => {
	let killed = false;
	await page.route('**/api/v1/benchmarks/live/', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				run: killed ? null : { model: 'qwen38', config_id: 'abc123', port: 8090 },
				summary: { 'util avg': 42, vram_headroom_mib: 512 },
				deltas: { prompt_tokens: 100 },
				requests: 3,
				recent_samples: [{ at: 1700000000, util_pct: 40, mem_used_mib: 5000, mem_total_mib: 6144 }],
				warning: null
			})
		})
	);
	await page.route('**/api/v1/benchmarks/live/kill', (route) => {
		killed = true;
		return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ killed: true }) });
	});

	await page.goto('/benchmarks/live');

	await expect(page.getByText('qwen38')).toBeVisible();
	await expect(page.getByText('abc123')).toBeVisible();

	await page.getByRole('button', { name: 'Kill' }).click();
	await expect(page.getByRole('heading', { name: 'Kill active run' })).toBeVisible();
	// AlertDialog, not Dialog, per Phase 5's own checklist wording -- clicking
	// the trigger must not kill anything by itself.
	await expect(page.getByText('the currently running server', { exact: false })).toBeVisible();

	await page.getByRole('button', { name: 'Kill', exact: true }).last().click();
	await expect(page.getByText('Nothing is currently being recorded')).toBeVisible();
});

test('Tests runs a suite and streams per-item outcomes to completion', async ({ page }) => {
	await page.route('**/api/v1/benchmarks/tests/options', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ tiers: ['smoke', 'standard'], benchmarks: ['humanevalplus'], systems: [] })
		})
	);
	await page.route('**/api/v1/benchmarks/tests/run', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ started: true }) })
	);
	await page.route('**/api/v1/benchmarks/tests/stream', (route) => {
		const events = [
			{ type: 'start', suite_run_id: '20260101T000000Z-abc123', total: 2, skipped: 0 },
			{
				type: 'item',
				benchmark: 'humanevalplus',
				item_id: 'HumanEval/0',
				outcome: 'pass',
				i: 1,
				total: 2,
				passed: 1,
				attempted: 1
			},
			{
				type: 'item',
				benchmark: 'humanevalplus',
				item_id: 'HumanEval/1',
				outcome: 'fail',
				reason: 'AssertionError',
				i: 2,
				total: 2,
				passed: 1,
				attempted: 2
			},
			{ type: 'done', passed: 1, attempted: 2, cancelled: false }
		];
		const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
		return route.fulfill({ status: 200, contentType: 'text/event-stream', body });
	});

	await page.goto('/benchmarks/tests');

	await expect(page.getByRole('heading', { name: 'Tests' })).toBeVisible();
	await page.getByRole('button', { name: 'Run', exact: true }).click();

	await expect(page.getByText('20260101T000000Z-abc123')).toBeVisible();
	await expect(page.getByText('HumanEval/0')).toBeVisible();
	await expect(page.getByText('HumanEval/1')).toBeVisible();
	await expect(page.getByText('AssertionError')).toBeVisible();
	await expect(page.getByText('1 / 2 passed')).toBeVisible();
});

// The Tests page's dataset actions (#141): each POSTs, then follows the one Tests stream.
async function mockTestsJob(page: Page, path: string, events: object[], { fetched: fetchedFirst = false } = {}) {
	const seen: { body: unknown } = { body: undefined };
	await page.route('**/api/v1/benchmarks/tests/options', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ tiers: ['smoke'], benchmarks: ['humanevalplus', 'mbppplus'], systems: [] })
		})
	);
	let datasetCalls = 0;
	await page.route('**/api/v1/benchmarks/tests/datasets', (route) => {
		datasetCalls += 1;
		const fetched = fetchedFirst || datasetCalls > 1;
		return route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify([
				{
					benchmark: 'humanevalplus',
					name: 'HumanEval+',
					fetched,
					vendored: false,
					n_items: fetched ? 164 : null,
					revision: fetched ? '463c980b59e8' : null,
					fetched_at: null,
					calibrated_at: null,
					n_checked: fetched ? 164 : null,
					n_ungradeable: fetched ? 1 : null,
					calibration_stale: fetched ? '' : 'not calibrated yet'
				}
			])
		});
	});
	await page.route(`**/api/v1/benchmarks/tests/${path}`, (route) => {
		seen.body = route.request().postDataJSON();
		return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ started: true }) });
	});
	await page.route('**/api/v1/benchmarks/tests/stream', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'text/event-stream',
			body: events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')
		})
	);
	return seen;
}

test('Fetch on a vendored dataset says it is in the repository', async ({ page }) => {
	await mockTestsJob(
		page,
		'fetch',
		[
			{ type: 'progress', benchmark: 'humanevalplus', message: 'fetching' },
			{
				type: 'dataset',
				benchmark: 'humanevalplus',
				n_items: 164,
				revision: 'v0.1.10@42526ec0e7d5',
				fetched: false,
				vendored: true
			},
			{ type: 'done', cancelled: false }
		],
		{ fetched: true }
	);
	await page.goto('/benchmarks/tests');
	const panel = page.getByRole('region', { name: 'Datasets' });
	await panel.getByRole('button', { name: 'Fetch', exact: true }).click();
	await expect(
		page.getByText('humanevalplus: in the repository, verified, 164 items, revision v0.1.10@42526ec0e7d5')
	).toBeVisible();
});

test('Tests fetches the datasets and shows what was downloaded', async ({ page }) => {
	const seen = await mockTestsJob(page, 'fetch', [
		{ type: 'progress', benchmark: 'humanevalplus', message: 'fetching' },
		{ type: 'dataset', benchmark: 'humanevalplus', n_items: 164, revision: '463c980b59e8', fetched: true },
		{ type: 'done', cancelled: false }
	]);
	await page.goto('/benchmarks/tests');
	const panel = page.getByRole('region', { name: 'Datasets' });
	await expect(panel.getByText('not fetched')).toBeVisible();
	// Nothing to check before anything is fetched.
	await expect(panel.getByRole('button', { name: 'Selfcheck' })).toBeDisabled();
	await panel.getByRole('button', { name: 'Fetch', exact: true }).click();
	await expect(page.getByText('humanevalplus: fetched, 164 items, revision 463c980b59e8')).toBeVisible();
	expect(seen.body).toEqual({});
	// The table is read again once the job ends.
	await expect(panel.getByText('163/164 gradeable')).toBeVisible();
});

test('Tests force-refetches only after confirming', async ({ page }) => {
	const seen = await mockTestsJob(page, 'fetch', [{ type: 'done', cancelled: false }]);
	await page.goto('/benchmarks/tests');
	page.once('dialog', (dialog) => dialog.accept());
	await page.getByRole('button', { name: 'Force refetch' }).click();
	await expect.poll(() => seen.body).toEqual({ force: true });
});

test('Tests selfcheck streams each reference solution and reports the calibration', async ({ page }) => {
	const seen = await mockTestsJob(
		page,
		'selfcheck',
		[
			{ type: 'progress', benchmark: 'humanevalplus', message: 'checking', total: 2 },
			{
				type: 'reference',
				benchmark: 'humanevalplus',
				item_id: 'HumanEval/0',
				outcome: 'pass',
				i: 1,
				total: 2,
				passed: 1
			},
			{
				type: 'reference',
				benchmark: 'humanevalplus',
				item_id: 'HumanEval/1',
				outcome: 'fail_error',
				reason: 'ImportError',
				i: 2,
				total: 2,
				passed: 1
			},
			{ type: 'calibrated', benchmark: 'humanevalplus', n_checked: 2, n_ungradeable: 1 },
			{ type: 'done', cancelled: false }
		],
		{ fetched: true }
	);
	await page.goto('/benchmarks/tests');
	await page.getByRole('button', { name: 'Selfcheck' }).click();
	await expect(page.getByText('HumanEval/1')).toBeVisible();
	await expect(page.getByText('ImportError')).toBeVisible();
	await expect(page.getByText('humanevalplus: calibrated, 1/2 gradeable here')).toBeVisible();
	expect(seen.body).toEqual({});
});

test('Tests runs one item and shows its answer without recording it', async ({ page }) => {
	const seen = await mockTestsJob(page, 'item', [
		{
			type: 'result',
			benchmark: 'mbppplus',
			item_id: '2',
			model: 'qwen',
			outcome: 'fail_assert',
			reason: 'AssertionError',
			excluded: 'fail_assert: its own reference fails here',
			wall_ms: 2300,
			content: '```python\ndef neg(a):\n    return a\n```'
		},
		{ type: 'done', cancelled: false }
	]);
	await page.goto('/benchmarks/tests');
	const form = page.getByRole('region', { name: 'Run one item' });
	await expect(form.getByRole('button', { name: 'Run item' })).toBeDisabled();
	await form.getByRole('combobox', { name: 'Item benchmark' }).click();
	await page.getByRole('option', { name: 'mbppplus' }).click();
	await form.getByLabel('Item id').fill('2');
	await form.getByRole('button', { name: 'Run item' }).click();
	const card = page.getByTestId('item-result');
	await expect(card).toContainText('mbppplus/2');
	await expect(card).toContainText('fail_assert');
	await expect(card).toContainText('A suite here leaves this item out: fail_assert: its own reference fails here');
	await expect(card).toContainText('def neg(a):');
	await expect(card).toContainText('2.3s');
	expect(seen.body).toEqual({ benchmark: 'mbppplus', item_id: '2' });
});

const compareOptions = { tiers: ['smoke'], benchmarks: ['ds1000'], systems: [] };

const compareRow = (over: Record<string, unknown>) => ({
	block: 'tier smoke | ds1000 | adapter abc | system -',
	model: 'qwen38',
	config_id: 'aaa111',
	tier: 'smoke',
	benchmark: 'ds1000',
	system: '-',
	adapter: 'abc',
	item_window: null,
	flags: { ngl: '20', fa: 'on' },
	dataset_revision: 'rev1',
	group: 'a',
	passed: 8,
	attempted: 8,
	n_problems: 8,
	n_samples: 8,
	n_clusters: null,
	se_kind: 'iid',
	pass_rate: 1,
	pass_rate_se: 0,
	pass_rate_ci: [0.6756, 1],
	prefill_tps: 50,
	gen_tps: 3,
	acceptance: null,
	passes_per_minute: 0.4123,
	passes_per_minute_ci: [0.3011, 0.5634],
	note: '',
	last_run: '2026-10-19T00:00:00Z',
	...over
});

// The real by=config shape (routers/benchmarks/compare.py): rows plus blocks
// with their pairs. A mock in an older shape is how #129 and #130 shipped.
const compareConfigBody = {
	rows: [
		compareRow({}),
		compareRow({
			config_id: 'bbb222',
			group: 'b',
			passed: 2,
			pass_rate: 0.25,
			pass_rate_ci: [0.072, 0.5907],
			passes_per_minute: 0.1
		})
	],
	blocks: [
		{
			key: 'tier smoke | ds1000 | adapter abc | system -',
			tier: 'smoke',
			benchmark: 'ds1000',
			adapter: 'abc',
			system: '-',
			item_window: '2025-01-01..2025-04-06',
			dataset_revision: 'rev1',
			levels: ['qwen38 @ aaa111', 'qwen38 @ bbb222'],
			letters: { 'qwen38 @ aaa111': 'a', 'qwen38 @ bbb222': 'b' },
			holm_m: 1,
			alpha: 0.05,
			pairs: [
				{
					a: 'qwen38 @ aaa111',
					b: 'qwen38 @ bbb222',
					n_shared: 8,
					mean_diff: 0.75,
					se: 0.16,
					ci: [0.37, 1.13],
					corr: null,
					test: 'exact McNemar',
					statistic: 0,
					discordant: [6, 0],
					p: 0.03125,
					p_holm: 0.03125,
					significant: true,
					mde: 0.45,
					mde_holm: 0.45,
					underpowered: false,
					n_clusters: null,
					note: ''
				}
			]
		}
	],
	notes: ['> warning: `aaa111` and `bbb222` differ in 2 flags (fa, ngl).']
};

test('Compare shows each block with intervals, groups and paired tests', async ({ page }) => {
	await page.route('**/api/v1/benchmarks/tests/options', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(compareOptions) })
	);
	await page.route(/\/api\/v1\/benchmarks\/compare\/\?/, (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(compareConfigBody) })
	);

	await page.goto('/benchmarks/compare');

	await expect(page.getByRole('heading', { name: 'Compare' })).toBeVisible();
	await expect(page.getByText('Release-date window: 2025-01-01..2025-04-06')).toBeVisible();
	await expect(page.getByText('100% [67.6, 100.0]')).toBeVisible();
	await expect(page.getByText('25% [7.2, 59.1]')).toBeVisible();
	await expect(page.getByText('0.412 [0.301, 0.563]')).toBeVisible();
	await expect(page.getByText('Holm across 1 test(s)', { exact: false })).toBeVisible();
	await expect(page.getByText('exact McNemar')).toBeVisible();
	await expect(page.getByText('different', { exact: true })).toBeVisible();
	await expect(page.getByText('differ in 2 flags', { exact: false })).toBeVisible();
});

test('Compare benchmark view renders flat per-benchmark columns and sorts on header click', async ({ page }) => {
	await page.route('**/api/v1/benchmarks/tests/options', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(compareOptions) })
	);
	await page.route(/\/api\/v1\/benchmarks\/compare\/\?by=config/, (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(compareConfigBody) })
	);
	await page.route(/\/api\/v1\/benchmarks\/compare\/\?by=benchmark/, (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				columns: ['model', 'config_id', 'tier', 'system', 'ds1000_passed', 'ds1000_pass_rate'],
				rows: [
					{
						model: 'qwen38',
						config_id: 'aaa111',
						tier: 'smoke',
						system: '-',
						ds1000_passed: '18/25',
						ds1000_pass_rate: 0.72
					},
					{
						model: 'qwen25c',
						config_id: 'bbb222',
						tier: 'smoke',
						system: '-',
						ds1000_passed: '23/25',
						ds1000_pass_rate: 0.92
					}
				],
				notes: []
			})
		})
	);

	await page.goto('/benchmarks/compare');
	await page.getByRole('combobox').first().click();
	await page.getByRole('option', { name: 'Benchmark' }).click();

	await expect(page.getByText('72%')).toBeVisible();
	await expect(page.getByText('18/25')).toBeVisible();

	// TanStack Table defaults a numeric column's first click to descending
	// (highest first), which is the more useful default for a rate column.
	const firstDataRow = page.getByRole('row').nth(1);
	await page.getByRole('columnheader', { name: 'Ds1000 Pass Rate' }).click();
	await expect(firstDataRow).toContainText('bbb222');
	await page.getByRole('columnheader', { name: 'Ds1000 Pass Rate' }).click();
	await expect(firstDataRow).toContainText('aaa111');
});

test('Compare serving view renders the serving rows and the derived table', async ({ page }) => {
	await page.route('**/api/v1/benchmarks/tests/options', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(compareOptions) })
	);
	await page.route(/\/api\/v1\/benchmarks\/compare\/\?by=config/, (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(compareConfigBody) })
	);
	await page.route(/\/api\/v1\/benchmarks\/compare\/\?by=serving/, (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				rows: [{ config_id: 'aaa111', model: 'qwen38', gen_tps: 2.97, build: '10597' }],
				derived: [{ config_id: 'aaa111', cpu_resident_layers: 45, ms_per_token: 336.7 }],
				notes: []
			})
		})
	);

	await page.goto('/benchmarks/compare');
	await page.getByRole('combobox').first().click();
	await page.getByRole('option', { name: 'Serving' }).click();

	await expect(page.getByRole('columnheader', { name: 'Gen Tps' })).toBeVisible();
	await expect(page.getByText('2.97')).toBeVisible();
	await expect(page.getByRole('columnheader', { name: 'Ms Per Token' })).toBeVisible();
	await expect(page.getByText('336.7')).toBeVisible();
});

test('Answers lists results and renders a selected transcript', async ({ page }) => {
	await page.route('**/api/v1/benchmarks/answers/runs**', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				runs: [
					{
						suite_run_id: '20260101T000000Z-abc123',
						started_at: 1700000000,
						model: 'qwen38',
						tier: 'smoke',
						attempted: 24,
						passed: 20
					}
				]
			})
		})
	);
	await page.route(/\/api\/v1\/benchmarks\/answers\/\?/, (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				rows: [
					{
						benchmark: 'humanevalplus',
						item_id: 'HumanEval/3',
						outcome: 'fail',
						reason: 'AssertionError',
						reasoning_chars: 120
					}
				]
			})
		})
	);
	await page.route(/\/api\/v1\/benchmarks\/answers\/one\?/, (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				benchmark: 'humanevalplus',
				item_id: 'HumanEval/3',
				model: 'qwen38',
				config_id: '71bc58dd',
				suite_run_id: '20260101T000000Z-abc123',
				system_name: null,
				outcome: 'fail',
				reason: 'AssertionError',
				timings: null,
				prompt: 'def has_close_elements(numbers, threshold):\n    """docstring"""',
				reasoning: null,
				reasoning_chars: 0,
				content: 'def has_close_elements(numbers, threshold):\n    return False  # wrong on purpose'
			})
		})
	);

	await page.goto('/benchmarks/answers');

	await expect(page.getByRole('heading', { name: 'Answers' })).toBeVisible();
	await expect(page.getByText('HumanEval/3')).toBeVisible();

	await page.getByText('HumanEval/3').click();
	await expect(page.getByText('wrong on purpose')).toBeVisible();
	await expect(page.getByText('71bc58dd')).toBeVisible();
});

test('Report generates and renders sanitized markdown plus a figure', async ({ page }) => {
	await page.route('**/api/v1/benchmarks/tests/options', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ tiers: ['smoke'], benchmarks: ['humanevalplus'], systems: [] })
		})
	);
	await page.route('**/api/v1/benchmarks/report/', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				markdown_url: '/api/v1/benchmarks/report/files/2026-01-01-abc123/report.md',
				figures: ['/api/v1/benchmarks/report/files/2026-01-01-abc123/fig1.png'],
				windows: ['2025-01-01..2025-04-06']
			})
		})
	);
	await page.route('**/api/v1/benchmarks/report/files/2026-01-01-abc123/report.md', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'text/plain',
			body: '# Serving comparison\n\n<script>window.__xss = true</script>\n\nqwen38 leads on pass rate.\n'
		})
	);
	// A 1x1 transparent PNG, just enough for the browser to accept it as a
	// real image response.
	const onePixelPng = Buffer.from(
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
		'base64'
	);
	await page.route('**/api/v1/benchmarks/report/files/2026-01-01-abc123/fig1.png', (route) =>
		route.fulfill({ status: 200, contentType: 'image/png', body: onePixelPng })
	);

	await page.goto('/benchmarks/report');

	await expect(page.getByRole('heading', { name: 'Report' })).toBeVisible();
	await page.getByRole('button', { name: 'Generate' }).click();

	await expect(page.getByRole('heading', { name: 'Serving comparison' })).toBeVisible();
	await expect(page.getByText('qwen38 leads on pass rate.')).toBeVisible();
	await expect(page.getByText('Release-date window: 2025-01-01..2025-04-06')).toBeVisible();
	await expect(page.locator('img[alt$="fig1.png"]')).toBeVisible();
	// DOMPurify stripped the <script> tag -- its text must not appear as
	// literal markup, and it must not have actually executed.
	await expect(page.locator('script:has-text("__xss")')).toHaveCount(0);
	expect(await page.evaluate(() => (window as unknown as { __xss?: boolean }).__xss)).toBeUndefined();
});

test('Tune shows sweep status streamed as whole-object replacements, and Stop requires confirmation', async ({
	page
}) => {
	await page.route('**/api/v1/benchmarks/serve/profiles', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ profiles: [] }) })
	);
	await page.route('**/api/v1/benchmarks/tests/options', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ tiers: ['smoke'], benchmarks: [], systems: [] })
		})
	);
	await page.route('**/api/v1/benchmarks/tune/grids', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ grids: [] }) })
	);
	await page.route('**/api/v1/benchmarks/tune/recent**', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sweeps: [] }) })
	);
	await page.route('**/api/v1/benchmarks/tune/log**', (route) => {
		// Two full-object status payloads, not an appended list -- the second
		// must fully replace the first (a third round added, a candidate's
		// score changed), exercising the "diff, don't append" contract Phase
		// 5's checklist calls out (docs/history/migration-plan.md).
		const events = [
			{
				sweep_id: '20260101-abc123',
				running: true,
				profile: 'qwen38',
				tier: 'smoke',
				rounds: [{ round: 1, stage: 'explore', item_from: 1, item_to: 8, survivors: 4, decision: 'continue' }],
				candidates: [
					{ candidate_sha: 'aaa', label: 'baseline', score: 0.5, is_baseline: true, status: 'active' },
					{ candidate_sha: 'bbb', label: 'candidate-b', score: 0.9, status: 'active' }
				]
			},
			{
				sweep_id: '20260101-abc123',
				running: false,
				verdict: 'adopted',
				profile: 'qwen38',
				tier: 'smoke',
				rounds: [
					{ round: 1, stage: 'explore', item_from: 1, item_to: 8, survivors: 4, decision: 'continue' },
					{ round: 2, stage: 'refine', item_from: 9, item_to: 16, survivors: 1, decision: 'adopt' }
				],
				candidates: [
					{ candidate_sha: 'aaa', label: 'baseline', score: 0.5, is_baseline: true, status: 'active' },
					{ candidate_sha: 'bbb', label: 'candidate-b', score: 0.9, status: 'winner' }
				]
			}
		];
		const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
		return route.fulfill({ status: 200, contentType: 'text/event-stream', body });
	});

	await page.goto('/benchmarks/tune');

	await expect(page.getByRole('heading', { name: 'Tune' })).toBeVisible();
	// The final (second) event's state, not an accumulation of both --
	// two rounds, "adopted", and candidate-b as the winner rather than
	// still "active".
	await expect(page.getByText('adopted')).toBeVisible();
	await expect(page.getByRole('row', { name: /^2\s/ })).toBeVisible();
	await expect(page.getByText('★ winner')).toBeVisible();
	await expect(page.getByRole('row').filter({ hasText: 'candidate-b' })).not.toContainText('active');

	// Stop is disabled once the sweep has already stopped running.
	await expect(page.getByRole('button', { name: 'Stop' })).toBeDisabled();
});

test('Pre-screen streams a running sweep and labels its candidates as raw llama-bench throughput', async ({ page }) => {
	const sweep = {
		sweep_id: '1793-abc',
		status: 'running',
		status_reason: null,
		profile: 'qwen38',
		sampler: 'grid',
		objective: 'tg',
		study_name: 'prescreen-1793-abc',
		grid_path: 'data/prescreen/qwen38.toml',
		model_file: 'Qwen3.8-27B-UD-Q3_K_XL.gguf',
		build_commit: 'f0fb5984b',
		build_number: 11875,
		gpu_info: 'GPU',
		driver_version: '590.48.01',
		n_prompt: 512,
		n_gen: 128,
		reps: 5
	};
	const point = (id: number, status: string, ngl: string) => ({
		point_id: id,
		phase: 'search',
		optuna_trial_number: id - 1,
		remeasure_of: null,
		overrides: { LLAMA_NGL: ngl },
		status,
		reason: null,
		tg_avg_ts: status === 'ok' ? 6.5 : null,
		tg_stddev_ts: null,
		pp_avg_ts: status === 'ok' ? 120 : null,
		pp_stddev_ts: null,
		peak_vram_mib: status === 'ok' ? 5300 : null
	});
	const candidate = {
		point_id: 2,
		rank: 1,
		is_baseline: false,
		changes: { ngl: '22' },
		tg: 6.5,
		pp: 120,
		measurements: 1,
		peak_vram_mib: 5300,
		ctx_check: null,
		ctx_check_free_mib: null,
		ctx_check_reason: null
	};
	const active = { sweep_id: '1793-abc', current: { point_id: 3, phase: 'search', overrides: { LLAMA_NGL: '24' } } };
	const running = {
		sweep,
		points: [point(1, 'ok', '20'), point(2, 'ok', '22')],
		candidates: [candidate],
		running: true,
		active,
		last_error: null
	};
	await page.route('**/api/v1/benchmarks/prescreen/grids', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ grids: [] }) })
	);
	await page.route('**/api/v1/benchmarks/prescreen/dashboard', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ running: false, url: 'http://127.0.0.1:8091/dashboard', port: 8091 })
		})
	);
	const next = { ...running, points: [...running.points, point(3, 'oom', '24')] };
	const done = { ...next, sweep: { ...sweep, status: 'done' }, running: false, active: null };
	// Running on the first read; finished once the stream has ended.
	let listed = 0;
	await page.route('**/api/v1/benchmarks/prescreen/sweeps?**', (route) => {
		const body = listed++
			? { sweeps: [done.sweep], running: false, active: null, last_error: null }
			: { sweeps: [sweep], running: true, active, last_error: null };
		return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
	});
	let read = 0;
	await page.route('**/api/v1/benchmarks/prescreen/sweeps/1793-abc', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(read++ ? done : running) })
	);
	await page.route('**/api/v1/benchmarks/prescreen/stream**', (route) => {
		const body = `data: ${JSON.stringify(running)}\n\ndata: ${JSON.stringify(next)}\n\nevent: done\ndata: {}\n\n`;
		return route.fulfill({ status: 200, contentType: 'text/event-stream', body });
	});

	await page.goto('/benchmarks/prescreen');

	await expect(page.getByRole('heading', { name: 'Pre-screen' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Pre-screen' })).toBeVisible();
	await expect(
		page.getByText('Candidates, raw llama-bench throughput (not a serving measurement): confirm with a full Tests run')
	).toBeVisible();
	await expect(page.getByRole('row').filter({ hasText: 'ngl 22' }).first()).toContainText('6.50');
	// The events replaced each other, and the final read replaced them: three
	// points, the third an OOM, and the sweep done.
	await expect(page.getByText('Points (3)')).toBeVisible();
	await expect(page.getByRole('cell', { name: 'oom' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeEnabled();
	await expect(page.getByRole('button', { name: 'Cancel' })).toBeDisabled();
});

test('a non-admin user is bounced out of Benchmarks entirely', async ({ page }) => {
	// Overrides this file's own beforeEach mock -- last-registered route wins
	// for a matching request in Playwright.
	await page.route('**/api/v1/auths/', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ ...adminUser, role: 'user' })
		})
	);

	await page.goto('/benchmarks/serve');

	// useBenchmarksGate.ts redirects to routePaths.home (react-router's own
	// navigate, not a full page load -- this is one of *our* routes).
	await expect(page).toHaveURL(/\/$/);
	await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
});

// docs/history/bug-review-2026-09-27.md M1: the log stream stays open as long as the
// server runs; the Start mutation used to await it, so the button read
// "Starting…" for the server's whole lifetime.
test('Serve Start settles while the log stream is still open', async ({ page }) => {
	let started = 0;
	await page.route('**/api/v1/benchmarks/serve/start', (route) => {
		started++;
		return route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ started: true, warning: null })
		});
	});
	// Never answered: a live server's log stream doesn't end.
	await page.route('**/api/v1/benchmarks/serve/stream', () => {});

	await page.goto('/benchmarks/serve');
	await page.getByRole('button', { name: 'Start' }).click();
	await expect.poll(() => started).toBe(1);
	await expect(page.getByText('Log (streaming…)')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Starting…' })).toHaveCount(0);
});

test('Tests Run settles while the run is still streaming', async ({ page }) => {
	await page.route('**/api/v1/benchmarks/tests/options', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ tiers: ['smoke'], benchmarks: [], systems: [] })
		})
	);
	await page.route('**/api/v1/benchmarks/tests/run', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ started: true }) })
	);
	await page.route('**/api/v1/benchmarks/tests/stream', () => {});

	await page.goto('/benchmarks/tests');
	await page.getByRole('button', { name: 'Run', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Cancel' })).toBeEnabled();
	await expect(page.getByRole('button', { name: 'Starting…' })).toHaveCount(0);
});
