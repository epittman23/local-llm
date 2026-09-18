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
