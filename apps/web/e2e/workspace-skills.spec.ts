import { expect, test } from './test';
import type { Page } from '@playwright/test';
import { mockWorkspaceBackend } from './workspace-helpers';

type Skill = {
	id: string;
	name: string;
	description: string;
	content: string;
	is_active: boolean;
	write_access: boolean;
	created_at: number;
	updated_at: number;
	access_grants: unknown[];
	user: { name: string; email: string };
};
const skill = (n: number, o: Partial<Skill> = {}): Skill => ({
	id: `skill-${n}`,
	name: `Skill ${n}`,
	description: `Does thing ${n}`,
	content: `Instructions ${n}`,
	is_active: true,
	write_access: true,
	created_at: 1700000000,
	updated_at: 1700000000 + n,
	access_grants: [],
	user: { name: 'test user', email: 'u@example.com' },
	...o
});

type Call = { method: string; path: string; search: string; body: any };

async function mockSkillsApi(page: Page, initial: Skill[]) {
	const state = { skills: [...initial] };
	const calls: Call[] = [];
	await page.route('**/api/v1/skills/**', async (route) => {
		const req = route.request();
		const url = new URL(req.url());
		const path = url.pathname.replace('/api/v1/skills', '');
		let body: any = null;
		try {
			body = req.postDataJSON();
		} catch {
			/* no body */
		}
		calls.push({ method: req.method(), path, search: url.search, body });
		const json = (d: unknown, status = 200) =>
			route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(d) });
		if (path === '/list') {
			const q = (url.searchParams.get('query') ?? '').toLowerCase();
			const items = state.skills.filter((s) => s.name.toLowerCase().includes(q));
			return json({ items, total: items.length });
		}
		if (path === '/create') {
			const created = skill(state.skills.length + 1, body);
			state.skills.unshift(created);
			return json(created);
		}
		const m = path.match(/^\/id\/([^/]+)(\/.*)?$/);
		if (m) {
			const found = state.skills.find((s) => s.id === m[1]);
			if (!found) return json({ detail: 'Not found' }, 404);
			const rest = m[2] ?? '';
			if (rest === '') return json(found);
			if (rest === '/toggle') return json({ ...found, is_active: !found.is_active });
			if (rest === '/delete') {
				state.skills = state.skills.filter((s) => s.id !== found.id);
				return json(true);
			}
			if (rest === '/update') return json({ ...found, ...body });
			if (rest === '/access/update') return json(found);
		}
		return json({});
	});
	return { calls, state };
}

test.describe('workspace skills', () => {
	test('lists skills, searches server-side, and marks inactive / read-only ones', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockSkillsApi(page, [
			skill(1),
			skill(2, { is_active: false }),
			skill(3, { write_access: false })
		]);
		await page.goto('/workspace/skills');
		await expect(page.getByText('Skill 1', { exact: true })).toBeVisible();
		await expect(page.getByText('Does thing 2')).toBeVisible();
		await expect(page.getByText('Inactive')).toHaveCount(1);
		await expect(page.getByText('Read Only')).toHaveCount(1);
		// A read-only skill has no row controls.
		await expect(page.getByRole('button', { name: 'Skill Menu', exact: true })).toHaveCount(2);

		await page.getByLabel('Search Skills').fill('3');
		await expect(page.getByText('Skill 1', { exact: true })).toHaveCount(0);
		expect(calls.some((c) => c.path === '/list' && c.search.includes('query=3'))).toBe(true);
	});

	test('the switch toggles and calls the API; delete confirms first', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockSkillsApi(page, [skill(1), skill(2)]);
		await page.goto('/workspace/skills');
		await page.getByRole('switch', { name: 'Enabled' }).first().click();
		await expect.poll(() => calls.some((c) => c.path.endsWith('/toggle'))).toBe(true);

		await page.getByRole('button', { name: 'Skill Menu', exact: true }).first().click();
		await page.getByRole('menuitem', { name: 'Delete' }).click();
		await expect(page.getByRole('alertdialog')).toContainText('This will delete');
		await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
		await expect.poll(() => calls.some((c) => c.path.endsWith('/delete'))).toBe(true);
	});

	test('create: id follows the name, frontmatter fills a blank form, and it posts', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockSkillsApi(page, []);
		await page.goto('/workspace/skills/create');

		await page.getByLabel('Skill Instructions').fill('---\nname: code-review_guide\ndescription: Review carefully\n---\nBody');
		await expect(page.getByLabel('Skill Name')).toHaveValue('Code Review Guide');
		await expect(page.getByLabel('Skill Description')).toHaveValue('Review carefully');

		await page.getByLabel('Skill Name').fill('Weekly Report');
		await expect(page.getByLabel('Skill ID')).toHaveValue('weekly-report');

		await page.getByRole('button', { name: 'Save & Create' }).click();
		await expect(page).toHaveURL(/\/workspace\/skills$/);
		expect(calls.find((c) => c.path === '/create')?.body).toMatchObject({
			id: 'weekly-report',
			name: 'Weekly Report',
			description: 'Review carefully',
			is_active: true,
			access_grants: []
		});
	});

	test('clone hands the skill to the create page pre-filled', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockSkillsApi(page, [skill(1)]);
		await page.goto('/workspace/skills');
		await page.getByRole('button', { name: 'Skill Menu', exact: true }).click();
		await page.getByRole('menuitem', { name: 'Clone' }).click();
		await expect(page).toHaveURL(/\/workspace\/skills\/create$/);
		await expect(page.getByLabel('Skill Name')).toHaveValue('Skill 1 (Clone)');
		await expect(page.getByLabel('Skill ID')).toHaveValue('skill-1_clone');
		await expect(page.getByLabel('Skill Instructions')).toHaveValue('Instructions 1');
	});

	test('import: a .md file opens the editor pre-filled; a .json file is created private', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockSkillsApi(page, []);
		await page.goto('/workspace/skills');

		await page.getByRole('button', { name: 'Open create menu' }).click();
		const chooser = page.waitForEvent('filechooser');
		await page.getByRole('menuitem', { name: 'Import JSON' }).click();
		await (await chooser).setFiles({
			name: 'my-skill.json',
			mimeType: 'application/json',
			buffer: Buffer.from(
				JSON.stringify([
					{
						id: 'imp',
						name: 'Imported',
						content: 'c',
						access_grants: [{ principal_type: 'user', principal_id: '*', permission: 'write' }]
					}
				])
			)
		});
		await expect.poll(() => calls.find((c) => c.path === '/create')?.body).toMatchObject({
			id: 'imp',
			name: 'Imported',
			access_grants: []
		});

		await page.getByRole('button', { name: 'Open create menu' }).click();
		const chooser2 = page.waitForEvent('filechooser');
		await page.getByRole('menuitem', { name: 'Import JSON' }).click();
		await (await chooser2).setFiles({
			name: 'SKILL.md',
			mimeType: 'text/markdown',
			buffer: Buffer.from('---\nname: from-file\ndescription: From a file\n---\nDo it.')
		});
		await expect(page).toHaveURL(/\/workspace\/skills\/create$/);
		await expect(page.getByLabel('Skill Name')).toHaveValue('From File');
		await expect(page.getByLabel('Skill ID')).toHaveValue('from-file');
	});

	test('edit: loads by ?id=, saves, and a read-only skill shows text with no Save', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockSkillsApi(page, [skill(1), skill(2, { write_access: false })]);
		await page.goto('/workspace/skills/edit?id=skill-1');
		await expect(page.getByLabel('Skill Name')).toHaveValue('Skill 1');
		await expect(page.getByText('skill-1', { exact: true })).toBeVisible(); // id shown as text
		await page.getByLabel('Skill Instructions').fill('New instructions');
		await page.getByRole('button', { name: 'Save', exact: true }).click();
		await expect.poll(() => calls.find((c) => c.path === '/id/skill-1/update')?.body).toMatchObject({
			id: 'skill-1',
			content: 'New instructions'
		});

		await page.goto('/workspace/skills/edit?id=skill-2');
		await expect(page.getByText('Read Only')).toBeVisible();
		await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
		await expect(page.locator('pre')).toHaveText('Instructions 2');
	});

	test('edit without an id, or with an unknown one, returns to the list', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockSkillsApi(page, []);
		await page.goto('/workspace/skills/edit');
		await expect(page).toHaveURL(/\/workspace\/skills$/);
		await page.goto('/workspace/skills/edit?id=missing');
		await expect(page).toHaveURL(/\/workspace\/skills$/);
	});
});
