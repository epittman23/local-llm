import { json, mockChat, savedChat } from './chat-helpers';
import { expect, test } from './test';

// A 1x1 PNG.
const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
	'base64'
);
const FIG = '00000000-0000-4000-8000-0000000000f1';

const reply = (content: string) =>
	savedChat('c1', 'Code', [
		{ id: 'u1', role: 'user', content: 'Plot it' },
		{ id: 'a1', role: 'assistant', content, model: 'qwen', modelName: 'Qwen', done: true }
	]);

// The user holds the code interpreter permission, which the Run button needs under the sandbox engine (Q26).
const sandbox = {
	features: { enable_code_execution: true, enable_code_interpreter: true },
	config: { code: { engine: 'sandbox' } },
	featurePermissions: { code_interpreter: true }
};

test("Run executes a reply's Python block in the chat's sandbox and shows its output and files", async ({ page }) => {
	await mockChat(page, { chats: [reply('Here:\n\n```python\nprint("hi")\n```\n')], user: sandbox });
	const runs: unknown[] = [];
	await page.route('**/api/v1/utils/code/execute', (route) => {
		runs.push(route.request().postDataJSON());
		return json(route, {
			stdout: 'hi\n',
			stderr: '',
			result: '',
			outputs: [{ path: 'outputs/fig.png' }],
			files: [
				{
					type: 'file',
					id: FIG,
					name: 'fig.png',
					url: `/api/v1/files/${FIG}/content`,
					meta: { source: 'sandbox_output', sandbox_path: 'outputs/fig.png', content_type: 'image/png' }
				}
			]
		});
	});
	await page.route(`**/api/v1/files/${FIG}/content*`, (route) =>
		route.fulfill({ status: 200, contentType: 'image/png', body: PNG })
	);
	await page.goto('/c/c1');

	const block = page.getByTestId('code-block');
	await block.getByRole('button', { name: 'Run' }).click();
	const output = block.getByTestId('code-run-output');
	await expect(output).toContainText('hi');
	await expect(output.getByRole('img', { name: /fig\.png/ })).toBeVisible();
	expect(runs).toEqual([{ code: 'print("hi")', chat_id: 'c1' }]);

	await output.getByRole('button', { name: 'Close output' }).click();
	await expect(block.getByTestId('code-run-output')).toHaveCount(0);
});

test("Run shows the endpoint's refusal", async ({ page }) => {
	await mockChat(page, { chats: [reply('```python\nprint(1)\n```\n')], user: sandbox });
	await page.route('**/api/v1/utils/code/execute', (route) =>
		route.fulfill({
			status: 404,
			contentType: 'application/json',
			body: JSON.stringify({ detail: "We could not find what you're looking for :/" })
		})
	);
	await page.goto('/c/c1');
	await page.getByTestId('code-block').getByRole('button', { name: 'Run' }).click();
	await expect(page.getByTestId('code-run-output')).toContainText('Run failed');
	await expect(page.getByTestId('code-run-output')).toContainText('could not find');
});

test('a Python block has no Run button under Pyodide', async ({ page }) => {
	await mockChat(page, {
		chats: [reply('```python\nprint(1)\n```\n')],
		user: {
			features: { enable_code_execution: true, enable_code_interpreter: true },
			config: { code: { engine: 'pyodide' } }
		}
	});
	await page.goto('/c/c1');
	await expect(page.getByTestId('code-block')).toBeVisible();
	await expect(page.getByTestId('code-block').getByRole('button', { name: 'Run' })).toHaveCount(0);
});

test('a user without the code interpreter permission gets no Run button under the sandbox engine', async ({ page }) => {
	await mockChat(page, {
		chats: [reply('Here:\n\n```python\nprint("hi")\n```\n')],
		user: { ...sandbox, featurePermissions: {} }
	});
	await page.goto('/c/c1');
	const block = page.getByTestId('code-block');
	await expect(block).toBeVisible();
	await expect(block.getByRole('button', { name: 'Run' })).toHaveCount(0);
});

test('no Run button while the code interpreter is switched off for the server, even with the permission', async ({
	page
}) => {
	await mockChat(page, {
		chats: [reply('Here:\n\n```python\nprint("hi")\n```\n')],
		user: { ...sandbox, features: { enable_code_execution: true, enable_code_interpreter: false } }
	});
	await page.goto('/c/c1');
	const block = page.getByTestId('code-block');
	await expect(block).toBeVisible();
	await expect(block.getByRole('button', { name: 'Run' })).toHaveCount(0);
});
