import { expect, test } from '@playwright/test';

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

test('Edit opens a version-history-backed form pre-filled from the current definition', async ({
	page
}) => {
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
				summary: { 'util avg': 42, 'vram_headroom_mib': 512 },
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
			body: JSON.stringify({ tiers: ['smoke', 'standard'], benchmarks: ['humaneval'], systems: [] })
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
				benchmark: 'humaneval',
				item_id: 'HumanEval/0',
				outcome: 'pass',
				i: 1,
				total: 2,
				passed: 1,
				attempted: 1
			},
			{
				type: 'item',
				benchmark: 'humaneval',
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
	await page.getByRole('button', { name: 'Run' }).click();

	await expect(page.getByText('20260101T000000Z-abc123')).toBeVisible();
	await expect(page.getByText('HumanEval/0')).toBeVisible();
	await expect(page.getByText('HumanEval/1')).toBeVisible();
	await expect(page.getByText('AssertionError')).toBeVisible();
	await expect(page.getByText('1 / 2 passed')).toBeVisible();
});

test('Compare renders rows generically and sorts on header click', async ({ page }) => {
	await page.route('**/api/v1/benchmarks/tests/options', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ tiers: ['smoke'], benchmarks: ['humaneval'], systems: [] })
		})
	);
	await page.route(/\/api\/v1\/benchmarks\/compare\/\?/, (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				rows: [
					{ model: 'qwen38', config_id: 'aaa111', pass_rate: 0.72 },
					{ model: 'qwen25c', config_id: 'bbb222', pass_rate: 0.91 }
				],
				notes: ['warning: two configurations differ in --n-cpu-moe']
			})
		})
	);

	await page.goto('/benchmarks/compare');

	await expect(page.getByRole('heading', { name: 'Compare' })).toBeVisible();
	await expect(page.getByText('72%')).toBeVisible();
	await expect(page.getByText('91%')).toBeVisible();
	await expect(page.getByText('warning: two configurations differ', { exact: false })).toBeVisible();

	// TanStack Table defaults a numeric column's first click to descending
	// (highest first) -- a real, deliberate difference from Compare.svelte's
	// own hand-rolled sort, which always started ascending regardless of
	// column type. Kept rather than fought, since "best result first" is the
	// more useful default for a rate column and the checklist asked for
	// TanStack Table specifically (docs/migration-plan.md).
	const firstDataRow = page.getByRole('row').nth(1);
	await page.getByRole('columnheader', { name: 'Pass Rate' }).click();
	await expect(firstDataRow).toContainText('bbb222');

	await page.getByRole('columnheader', { name: 'Pass Rate' }).click();
	await expect(firstDataRow).toContainText('aaa111');
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
						benchmark: 'humaneval',
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
				benchmark: 'humaneval',
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
			body: JSON.stringify({ tiers: ['smoke'], benchmarks: ['humaneval'], systems: [] })
		})
	);
	await page.route('**/api/v1/benchmarks/report/', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				markdown_url: '/api/v1/benchmarks/report/files/2026-01-01-abc123/report.md',
				figures: ['/api/v1/benchmarks/report/files/2026-01-01-abc123/fig1.png']
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
	await expect(page.locator('img[alt$="fig1.png"]')).toBeVisible();
	// DOMPurify stripped the <script> tag -- its text must not appear as
	// literal markup, and it must not have actually executed.
	await expect(page.locator('script:has-text("__xss")')).toHaveCount(0);
	expect(await page.evaluate(() => (window as unknown as { __xss?: boolean }).__xss)).toBeUndefined();
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
	await expect(page.getByRole('heading', { name: 'Chat' })).toBeVisible();
});
