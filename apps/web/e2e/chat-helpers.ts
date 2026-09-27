import type { Page } from '@playwright/test';
import { fakeSocketServer } from './fake-socket';
import { mockWorkspaceBackend, type MockUserOptions } from './workspace-helpers';

type Rec = Record<string, any>;
export const json = (route: any, d: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(d) });

export const MODELS = [
	{ id: 'qwen', name: 'Qwen', info: { meta: { description: 'A **fast** model', suggestion_prompts: [{ content: 'Tell me a joke', title: ['Tell me', 'a joke'] }] } } },
	{ id: 'llama', name: 'Llama' },
	{ id: 'secret', name: 'Secret', info: { meta: { hidden: true } } }
];

/** A saved chat record as GET /chats/<id> returns it. */
export function savedChat(id: string, title: string, messages: Rec[], extra: Rec = {}) {
	const history: { messages: Record<string, Rec>; currentId: string | null } = { messages: {}, currentId: messages.at(-1)?.id ?? null };
	messages.forEach((m, i) => {
		history.messages[m.id] = { parentId: i ? messages[i - 1].id : null, childrenIds: [], timestamp: 1_700_000_000 + i, ...m };
	});
	for (const m of Object.values(history.messages)) if (m.parentId && history.messages[m.parentId] && !history.messages[m.parentId].childrenIds.includes(m.id)) history.messages[m.parentId].childrenIds.push(m.id);
	return { id, title, user_id: 'u1', updated_at: 1_700_000_000, created_at: 1_700_000_000, pinned: false, archived: false, folder_id: null, share_id: null, chat: { title, models: ['qwen'], history, params: {}, files: [], ...extra.chat }, ...extra };
}

/**
 * The chat backend: models, chats (get/update/list), the completion POST and
 * task stop. Completions are answered like the real server (task id, and a
 * chat id for a new chat); the reply itself is streamed by the spec through
 * the fake socket with `stream()`.
 */
export async function mockChat(page: Page, { chats = [] as Rec[], user = {} as MockUserOptions, completion = {} as Rec, folders = [] as Rec[] } = {}) {
	await mockWorkspaceBackend(page, { role: 'user', ...user });
	const socket = await fakeSocketServer(page);
	const seen = { completions: [] as Rec[], updates: [] as Rec[], stops: [] as string[], lists: 0, actions: [] as string[], searches: [] as string[], folderCalls: [] as string[] };
	const byId = new Map(chats.map((c) => [c.id, c]));
	await page.route('**/api/models*', (route) => json(route, { data: MODELS }));
	await page.route('**/api/chat/completions', async (route) => {
		const body = route.request().postDataJSON();
		seen.completions.push(body);
		return json(route, { status: true, task_id: `t${seen.completions.length}`, ...(body.chat_id ? {} : { chat_id: 'new1' }), ...completion });
	});
	await page.route('**/api/tasks/**', async (route) => {
		const url = route.request().url();
		if (url.includes('/stop')) seen.stops.push(url);
		return json(route, url.includes('/stop') ? { status: true } : { task_ids: [] });
	});
	const listItem = (c: Rec) => ({ id: c.id, title: c.title, updated_at: c.updated_at, created_at: c.created_at, last_read_at: c.last_read_at ?? c.updated_at, time_range: c.time_range ?? 'Today', pinned: c.pinned, folder_id: c.folder_id ?? null });
	await page.route(/\/api\/v1\/chats(\/|\?|$)/, async (route) => {
		const req = route.request();
		const url = new URL(req.url());
		const path = url.pathname.replace(/^.*\/api\/v1\/chats/, '');
		if (path === '/' || path === '') {
			seen.lists++;
			return json(route, Number(url.searchParams.get('page') ?? 1) > 1 ? [] : [...byId.values()].filter((c) => !c.pinned && !c.folder_id && !c.archived).map(listItem));
		}
		if (path === '/pinned') return json(route, [...byId.values()].filter((c) => c.pinned).map(listItem));
		if (path === '/search') {
			seen.searches.push(url.searchParams.get('text') ?? '');
			return json(route, [...byId.values()].filter((c) => c.title.toLowerCase().includes((url.searchParams.get('text') ?? '').toLowerCase())).map(listItem));
		}
		if (path.startsWith('/folder/')) {
			const fid = path.split('/')[2];
			return json(route, Number(url.searchParams.get('page') ?? 1) > 1 ? [] : [...byId.values()].filter((c) => c.folder_id === fid).map(listItem));
		}
		if (path === '/all/tags') return json(route, []);
		const [, id, action] = path.split('/');
		const cur = byId.get(id);
		if (action === 'tags') return json(route, []);
		if (action) {
			seen.actions.push(`${action}:${id}`);
			if (!cur) return json(route, { detail: 'Not found' }, 404);
			if (action === 'pin') byId.set(id, { ...cur, pinned: !cur.pinned });
			if (action === 'archive') byId.set(id, { ...cur, archived: true });
			if (action === 'folder') byId.set(id, { ...cur, folder_id: req.postDataJSON()?.folder_id ?? null });
			if (action === 'share') {
				if (req.method() === 'DELETE') byId.set(id, { ...cur, share_id: null });
				else byId.set(id, { ...cur, share_id: `share-${id}` });
				return json(route, byId.get(id));
			}
			if (action === 'clone') {
				const clone = { ...cur, id: `${id}-clone`, title: req.postDataJSON()?.title ?? cur.title };
				byId.set(clone.id, clone);
				return json(route, clone);
			}
			if (action === 'unread') return json(route, { ...cur, last_read_at: 0 });
			return json(route, byId.get(id));
		}
		if (req.method() === 'DELETE') {
			seen.actions.push(`delete:${id}`);
			byId.delete(id);
			return json(route, true);
		}
		if (req.method() === 'POST') {
			const body = req.postDataJSON();
			seen.updates.push({ id, ...body });
			const base = cur ?? savedChat(id, 'New Chat', []);
			const next = { ...base, title: body.chat?.title ?? base.title, chat: { ...base.chat, ...body.chat } };
			byId.set(id, next);
			return json(route, next);
		}
		return cur ? json(route, cur) : json(route, { detail: 'Not found' }, 404);
	});
	let folderList = [...folders];
	await page.route(/\/api\/v1\/folders(\/|\?|$)/, async (route) => {
		const req = route.request();
		const path = new URL(req.url()).pathname.replace(/^.*\/api\/v1\/folders/, '');
		seen.folderCalls.push(`${req.method()} ${path}`);
		if (path === '/' && req.method() === 'GET') return json(route, folderList);
		if (path === '/' && req.method() === 'POST') {
			const f = { id: `f${folderList.length + 1}`, ...req.postDataJSON() };
			folderList = [...folderList, f];
			return json(route, f);
		}
		const [, id, action] = path.split('/');
		if (req.method() === 'DELETE') {
			folderList = folderList.filter((f) => f.id !== id);
			return json(route, true);
		}
		if (action === 'update') {
			folderList = folderList.map((f) => (f.id === id ? { ...f, ...req.postDataJSON() } : f));
			return json(route, folderList.find((f) => f.id === id));
		}
		if (action) return json(route, true);
		const f = folderList.find((x) => x.id === id);
		return f ? json(route, f) : json(route, { detail: 'Not found' }, 404);
	});

	/** Streams `text` into the reply the last completion asked for, word by word, then finishes it. */
	const stream = async (text: string, extra: Rec = {}) => {
		const body = seen.completions.at(-1)!;
		const chatId = body.chat_id ?? 'new1';
		for (const word of text.split(/(?<= )/)) socket.emit('events', { chat_id: chatId, message_id: body.id, data: { type: 'chat:completion', data: { choices: [{ delta: { content: word } }] } } });
		socket.emit('events', { chat_id: chatId, message_id: body.id, data: { type: 'chat:completion', data: { done: true, ...extra } } });
	};
	const event = (type: string, data: unknown, messageId?: string) => {
		const body = seen.completions.at(-1)!;
		socket.emit('events', { chat_id: body.chat_id ?? 'new1', message_id: messageId ?? body.id, data: { type, data } });
	};
	return { socket, seen, stream, event, byId };
}
