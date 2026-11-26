import type { Page } from '@playwright/test';
import { mockChat, savedChat } from './chat-helpers';
import { expect, test } from './test';

// Saving a version of a sandbox output back to its workspace file (Phase 4 (d), CNV-6): the Copy menu's Save to
// workspace, the same action beside Attach to next message after a save, and the dialog the server's `changed` 409
// opens. The backend is mocked; docs/guides/sandbox.md "Writing an edit back" is the route's contract.

const uuid = (key: string) => `00000000-0000-4000-8000-${key.padStart(12, '0')}`;
const FIT = uuid('f1');
const V2 = uuid('f2');
const SOURCE = 'import numpy as np\n\ndef fit(x):\n    return np.mean(x)\n';

const canvas = (page: Page) => page.getByRole('complementary', { name: 'Canvas' });
const SAVED = 'Saved to the workspace. The model sees it the next time it reads the file.';

type Answer = { status: number; json: Record<string, unknown> };
const WRITTEN: Answer = { status: 200, json: { path: 'outputs/fit.py', bytes: 41 } };

/** A chat with one output script that has a saved version 2, and a write-back route that answers from `answers`. */
async function mockWriteBack(page: Page, answers: Answer[], owner = 'u1') {
	const posts: { id: string; body: unknown }[] = [];
	await mockChat(page, {
		chats: [
			savedChat(
				'c1',
				'Fit',
				[
					{ id: 'u1', role: 'user', content: 'Fit it' },
					{
						id: 'a1',
						role: 'assistant',
						content: 'Done.',
						model: 'qwen',
						modelName: 'Qwen',
						done: true,
						files: [
							{
								type: 'file',
								id: FIT,
								name: 'fit.py',
								url: `/api/v1/files/${FIT}/content`,
								size: SOURCE.length,
								meta: { source: 'sandbox_output', sandbox_path: '/workspace/outputs/fit.py' }
							}
						]
					}
				],
				{ user_id: owner }
			)
		]
	});
	await page.route('**/api/v1/files/*/content*', (route) =>
		route.fulfill({ status: 200, contentType: 'application/octet-stream', body: SOURCE })
	);
	await page.route('**/api/v1/files/*/versions', async (route) => {
		if (route.request().method() === 'POST') {
			return route.fulfill({
				json: { id: V2, filename: 'fit.py', data: {}, meta: { version: 2, size: SOURCE.length } }
			});
		}
		return route.fulfill({
			json: [
				{ id: FIT, version: 1, size: SOURCE.length, created_at: 1_700_000_000, name: 'fit.py' },
				{ id: V2, version: 2, size: SOURCE.length, created_at: 1_700_000_100, name: 'fit.py' }
			]
		});
	});
	await page.route('**/api/v1/sandbox/outputs/*/write-back', async (route) => {
		const parts = new URL(route.request().url()).pathname.split('/');
		posts.push({ id: parts.at(-2) ?? '', body: route.request().postDataJSON() });
		const answer = answers[Math.min(posts.length - 1, answers.length - 1)];
		return route.fulfill({ status: answer.status, json: answer.json });
	});
	return { posts };
}

const openFit = async (page: Page) => {
	await page.goto('/c/c1');
	await page.getByTestId('document-card').filter({ hasText: 'fit.py' }).click();
	await expect(canvas(page)).toBeVisible();
	await expect(canvas(page).getByRole('button', { name: 'Version 2 of 2' })).toBeVisible();
};
const saveToWorkspace = async (page: Page) => {
	await canvas(page).getByRole('button', { name: 'Copy' }).click();
	await page.getByRole('menuitem', { name: 'Save to workspace' }).click();
};

test.beforeEach(async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
});

test('Save to workspace writes the latest version and says the model sees it when it reads the file', async ({
	page
}) => {
	const server = await mockWriteBack(page, [WRITTEN]);
	await openFit(page);
	await saveToWorkspace(page);
	await expect(page.getByText(SAVED)).toBeVisible();
	expect(server.posts).toEqual([{ id: V2, body: { force: false } }]);
});

test('a changed file asks first, and Replace repeats the request with force', async ({ page }) => {
	const changed: Answer = {
		status: 409,
		json: { code: 'changed', missing: false, detail: 'The file in the workspace changed after this version.' }
	};
	const server = await mockWriteBack(page, [changed, WRITTEN]);
	await openFit(page);
	await saveToWorkspace(page);
	const ask = page.getByRole('alertdialog', { name: 'Replace the workspace file?' });
	await expect(ask).toBeVisible();
	await expect(ask).toContainText(
		'The file in the workspace changed after this version. Replace it with this version?'
	);
	await ask.getByRole('button', { name: 'Replace' }).click();
	await expect(page.getByText(SAVED)).toBeVisible();
	expect(server.posts.map((p) => p.body)).toEqual([{ force: false }, { force: true }]);
});

test('a file that is gone says it will be created, and Cancel writes nothing', async ({ page }) => {
	const gone: Answer = { status: 409, json: { code: 'changed', missing: true, detail: 'changed' } };
	const server = await mockWriteBack(page, [gone]);
	await openFit(page);
	await saveToWorkspace(page);
	const ask = page.getByRole('alertdialog', { name: 'Create the workspace file?' });
	await expect(ask).toContainText('The file is no longer in the workspace. Create it with this version?');
	await ask.getByRole('button', { name: 'Cancel' }).click();
	await expect(ask).toHaveCount(0);
	expect(server.posts).toHaveLength(1);
});

test('a busy workspace and a failure are toasts, and the action can be tried again', async ({ page }) => {
	const busy: Answer = { status: 409, json: { code: 'busy', detail: 'busy' } };
	const down: Answer = { status: 503, json: { detail: 'The sandbox is not running' } };
	const server = await mockWriteBack(page, [busy, down, WRITTEN]);
	await openFit(page);
	await saveToWorkspace(page);
	await expect(page.getByText('The workspace is busy. Try again when the reply has finished.')).toBeVisible();
	await saveToWorkspace(page);
	await expect(page.getByText('Could not save to the workspace. Try again.')).toBeVisible();
	await saveToWorkspace(page);
	await expect(page.getByText(SAVED)).toBeVisible();
	expect(server.posts).toHaveLength(3);
});

test('after a save the toast offers Save to workspace beside Attach to next message', async ({ page }) => {
	const server = await mockWriteBack(page, [WRITTEN]);
	await openFit(page);
	await canvas(page).getByRole('button', { name: 'Edit document' }).click();
	await canvas(page).getByRole('textbox', { name: 'Edit fit.py' }).pressSequentially('# edited');
	await canvas(page).getByRole('button', { name: 'Save document' }).click();
	const toast = page.locator('[data-sonner-toast]').filter({ hasText: 'Saved as version 2' });
	await expect(toast.getByRole('button', { name: 'Attach to next message' })).toBeVisible();
	await expect(toast.getByText('Saved as version 2')).toBeVisible();
	await toast.getByRole('button', { name: 'Save to workspace' }).click();
	await expect(page.getByText(SAVED)).toBeVisible();
	expect(server.posts).toEqual([{ id: V2, body: { force: false } }]);
});

test('a chat that is not the signed-in user’s own offers no Save to workspace', async ({ page }) => {
	await mockWriteBack(page, [WRITTEN], 'someone-else');
	await openFit(page);
	await canvas(page).getByRole('button', { name: 'Copy' }).click();
	await expect(page.getByRole('menuitem', { name: 'Download' })).toBeVisible();
	await expect(page.getByRole('menuitem', { name: 'Save to workspace' })).toHaveCount(0);
});
