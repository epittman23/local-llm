import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PENDING_WORKSPACE_IDS_KEY, type PendingWorkspace } from '@/lib/apis/sandbox';
import { useAuthStore } from '@/lib/stores/authStore';
import { OPTION_TITLE_MAX, optionTitle, PendingWorkspacesDialog } from './PendingWorkspacesDialog';

const toastError = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({
	toast: Object.assign(vi.fn(), { error: toastError, success: toastSuccess, info: vi.fn() })
}));

const EXPIRED: PendingWorkspace = {
	id: 'w-old',
	chat_id: 'w-old',
	chat_title: 'Old analysis',
	reason: 'expired',
	since: 1_700_000_000,
	created_at: 1_690_000_000,
	last_used_at: 1_690_000_000,
	contents: {
		files: [
			{ path: 'data/sales.csv', size: 2048, mtime: 1_690_000_000 },
			{ path: 'outputs/plot.png', size: 10, mtime: 1_690_000_100 }
		],
		file_count: 450,
		total_bytes: 5 * 1024 * 1024,
		complete: false
	},
	contents_error: null
};

const CAP: PendingWorkspace = {
	id: 'w-lru',
	chat_id: 'w-lru',
	chat_title: null,
	reason: 'cap',
	since: 1_700_000_000,
	created_at: 1_690_000_000,
	last_used_at: 1_695_000_000,
	contents: null,
	contents_error: 'The contents could not be listed.',
	waiting_chat_id: 'new-chat',
	waiting_chat_title: 'New report',
	workspaces: [{ id: 'w-other', chat_id: 'w-other', chat_title: 'Other chat', last_used_at: 1_699_000_000 }]
};

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];
let ids: string[] = [];
let pending: PendingWorkspace[] = [];
let answer: () => Response = () => Response.json({ ok: true });

beforeEach(() => {
	calls = [];
	ids = [EXPIRED.id, CAP.id];
	pending = [EXPIRED, CAP];
	answer = () => Response.json({ ok: true });
	toastError.mockReset();
	toastSuccess.mockReset();
	useAuthStore.setState({ token: 't' } as never);
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
		const url = String(input);
		const method = init?.method ?? 'GET';
		calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
		if (method === 'POST') return answer();
		if (url.endsWith('/sandbox/pending/ids')) return Response.json({ ids });
		if (url.endsWith('/sandbox/pending')) return Response.json({ pending, max_workspaces: 20, retention_days: 7 });
		return new Response('{}', { status: 404 });
	});
});

afterEach(() => vi.restoreAllMocks());

const renderDialog = () => {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<PendingWorkspacesDialog />
		</QueryClientProvider>
	);
	return client;
};

const listings = () => calls.filter((c) => c.url.endsWith('/sandbox/pending')).length;
const item = (name: string) => screen.getByRole('region', { name: `Workspace of ${name}` });

describe('PendingWorkspacesDialog', () => {
	it('shows nothing, and lists nothing, when no workspace waits', async () => {
		ids = [];
		renderDialog();
		await waitFor(() => expect(calls.some((c) => c.url.endsWith('/pending/ids'))).toBe(true));
		expect(screen.queryByRole('dialog')).toBeNull();
		expect(listings()).toBe(0);
	});

	it('shows nothing when the ids cannot be read', async () => {
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('down', { status: 502 }));
		renderDialog();
		await act(async () => {});
		expect(screen.queryByRole('dialog')).toBeNull();
	});

	it('lists each waiting workspace with its chat, reason and contents', async () => {
		renderDialog();
		expect(await screen.findByRole('dialog')).toBeTruthy();
		const old = await screen.findByRole('region', { name: 'Workspace of Old analysis' });
		expect(within(old).getByText(/Not used for more than 7 days/)).toBeTruthy();
		expect(within(old).getByText('data/sales.csv')).toBeTruthy();
		expect(within(old).getByText('2.0 KB')).toBeTruthy();
		expect(within(old).getByTestId('workspace-totals').textContent).toBe(
			'450 files, 5.0 MB (the first 2 shown); some folders could not be read'
		);
		const cap = item('Untitled chat');
		expect(
			within(cap).getByText(/"\u2068New report\u2069" needs a code workspace, and you have the most allowed \(20\)/)
		).toBeTruthy();
		expect(within(cap).getByText('The contents could not be listed.')).toBeTruthy();
		const choices = within(cap).getByLabelText('Workspace to remove');
		expect(Array.from(choices.querySelectorAll('option')).map((o) => o.value)).toEqual(['w-lru', 'w-other']);
		// No choice for an expired workspace: it is removed or kept itself.
		expect(within(old).queryByLabelText('Workspace to remove')).toBeNull();
	});

	it('removes another workspace for a cap request, then drops the item without listing again', async () => {
		renderDialog();
		const cap = await screen.findByRole('region', { name: 'Workspace of Untitled chat' });
		fireEvent.change(within(cap).getByLabelText('Workspace to remove'), { target: { value: 'w-other' } });
		ids = [EXPIRED.id];
		fireEvent.click(within(cap).getByRole('button', { name: 'Remove workspace of Untitled chat' }));
		await waitFor(() => expect(screen.queryByRole('region', { name: 'Workspace of Untitled chat' })).toBeNull());
		expect(calls.filter((c) => c.method === 'POST')).toEqual([
			{
				url: '/api/v1/sandbox/pending/w-lru',
				method: 'POST',
				body: { action: 'remove', since: 1_700_000_000, workspace: 'w-other' }
			}
		]);
		expect(toastSuccess).toHaveBeenCalledWith('Workspace removed.');
		expect(item('Old analysis')).toBeTruthy();
		await waitFor(() => expect(calls.filter((c) => c.url.endsWith('/pending/ids')).length).toBe(2));
		expect(listings()).toBe(1);
	});

	it('keeps an expired workspace, and closes once nothing is left', async () => {
		ids = [EXPIRED.id];
		pending = [EXPIRED];
		renderDialog();
		const old = await screen.findByRole('region', { name: 'Workspace of Old analysis' });
		ids = [];
		fireEvent.click(within(old).getByRole('button', { name: 'Keep workspace of Old analysis' }));
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ action: 'keep', since: 1_700_000_000 });
		expect(toastSuccess).toHaveBeenCalledWith('Workspace kept.');
	});

	it('says why an answer failed and keeps the item', async () => {
		answer = () => Response.json({ detail: "The workspace's chat is running code" }, { status: 409 });
		renderDialog();
		const old = await screen.findByRole('region', { name: 'Workspace of Old analysis' });
		fireEvent.click(within(old).getByRole('button', { name: 'Remove workspace of Old analysis' }));
		await waitFor(() => expect(toastError).toHaveBeenCalledWith("The workspace's chat is running code"));
		expect(item('Old analysis')).toBeTruthy();
	});

	it('says when the workspaces cannot be listed', async () => {
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
			String(input).endsWith('/ids')
				? Response.json({ ids: ['w-old'] })
				: Response.json({ detail: 'down' }, { status: 503 })
		);
		renderDialog();
		expect(await screen.findByText('The workspaces could not be listed: down')).toBeTruthy();
	});

	it('stays closed after Decide later until a new request arrives', async () => {
		const client = renderDialog();
		await screen.findByRole('region', { name: 'Workspace of Old analysis' });
		fireEvent.click(screen.getByRole('button', { name: 'Decide later' }));
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		// A reply finishes with nothing new: still closed.
		await act(() => client.invalidateQueries({ queryKey: PENDING_WORKSPACE_IDS_KEY }));
		expect(screen.queryByRole('dialog')).toBeNull();
		// A reply hit the limit for another chat: it opens again, listing afresh.
		ids = [EXPIRED.id, CAP.id, 'w-new'];
		pending = [EXPIRED, CAP, { ...CAP, id: 'w-new', chat_title: 'Third' }];
		await act(() => client.invalidateQueries({ queryKey: PENDING_WORKSPACE_IDS_KEY }));
		expect(await screen.findByRole('region', { name: 'Workspace of Third' })).toBeTruthy();
		expect(listings()).toBe(2);
	});

	it('offers Retry when the list cannot be read, and lists again on it', async () => {
		let fail = true;
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const url = String(input);
			if (url.endsWith('/ids')) return Response.json({ ids: ['w-old'] });
			if (fail) return Response.json({ detail: 'down' }, { status: 503 });
			return Response.json({ pending: [EXPIRED], max_workspaces: 20, retention_days: 7 });
		});
		renderDialog();
		await screen.findByText('The workspaces could not be listed: down');
		fail = false;
		fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
		expect(await screen.findByRole('region', { name: 'Workspace of Old analysis' })).toBeTruthy();
	});

	it('drops a removed workspace from the choices of the other items', async () => {
		const second: PendingWorkspace = {
			...CAP,
			id: 'w-two',
			chat_title: 'Second',
			since: 1_700_000_500,
			workspaces: [
				{ id: 'w-other', chat_id: 'w-other', chat_title: 'Other chat', last_used_at: 1 },
				{ id: 'w-lru', chat_id: 'w-lru', chat_title: null, last_used_at: 2 }
			]
		};
		ids = [CAP.id, second.id];
		pending = [CAP, second];
		renderDialog();
		const cap = await screen.findByRole('region', { name: 'Workspace of Untitled chat' });
		fireEvent.change(within(cap).getByLabelText('Workspace to remove'), { target: { value: 'w-other' } });
		ids = [second.id];
		fireEvent.click(within(cap).getByRole('button', { name: 'Remove workspace of Untitled chat' }));
		await waitFor(() => expect(screen.queryByRole('region', { name: 'Workspace of Untitled chat' })).toBeNull());
		const choices = within(item('Second')).getByLabelText('Workspace to remove');
		// w-other is gone; w-lru, whose request was answered without removing it, stays a choice.
		expect(Array.from(choices.querySelectorAll('option')).map((o) => o.value)).toEqual(['w-two', 'w-lru']);
		expect(listings()).toBe(1);
	});

	it('asks again for the ids and the list after a refused answer', async () => {
		answer = () => Response.json({ detail: 'This request changed since it was shown' }, { status: 409 });
		renderDialog();
		const old = await screen.findByRole('region', { name: 'Workspace of Old analysis' });
		fireEvent.click(within(old).getByRole('button', { name: 'Keep workspace of Old analysis' }));
		await waitFor(() => expect(toastError).toHaveBeenCalledWith('This request changed since it was shown'));
		await waitFor(() => expect(listings()).toBe(2));
		expect(calls.filter((c) => c.url.endsWith('/pending/ids')).length).toBeGreaterThanOrEqual(2);
	});

	it('isolates names in their own direction and keeps rows whose names repeat', async () => {
		const rtl = '\u202Egpj.exe';
		ids = [EXPIRED.id];
		pending = [
			{
				...EXPIRED,
				chat_title: rtl,
				contents: {
					files: [
						{ path: 'same\u2026', size: 1, mtime: 1, truncated: true },
						{ path: 'same\u2026', size: 2, mtime: 2, truncated: true }
					],
					file_count: 2,
					total_bytes: 3,
					complete: true
				}
			}
		];
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		renderDialog();
		const region = await screen.findByRole('region', { name: `Workspace of ${rtl}` });
		expect(region.querySelector('h3 bdi')?.textContent).toBe(rtl);
		const cells = within(region).getAllByText('same\u2026');
		expect(cells).toHaveLength(2);
		expect(cells.every((c) => c.tagName === 'BDI')).toBe(true);
		expect(within(region).getAllByText('(name shortened)')).toHaveLength(2);
		expect(errors.mock.calls.some((c) => String(c[0]).includes('same key'))).toBe(false);
	});
});

describe('optionTitle', () => {
	it('isolates a title and cuts one longer than OPTION_TITLE_MAX with an ellipsis, by character', () => {
		expect(optionTitle('Sales')).toBe('\u2068Sales\u2069');
		expect(optionTitle(null)).toBe('\u2068Untitled chat\u2069');
		const long = '\u{1F600}'.repeat(OPTION_TITLE_MAX + 5);
		const shown = Array.from(optionTitle(long));
		expect(shown).toHaveLength(OPTION_TITLE_MAX + 2);
		expect(shown.at(-2)).toBe('\u2026');
		expect(Array.from(optionTitle('x'.repeat(OPTION_TITLE_MAX)))).toHaveLength(OPTION_TITLE_MAX + 2);
		expect(optionTitle('x'.repeat(OPTION_TITLE_MAX))).not.toContain('\u2026');
	});

	it('keeps an emoji sequence whole at the cut and drops direction controls', () => {
		const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
		const shown = optionTitle(`${'x'.repeat(OPTION_TITLE_MAX - 2)}${family}${family}${family}`);
		expect(shown).toBe(`\u2068${'x'.repeat(OPTION_TITLE_MAX - 2)}${family}\u2026\u2069`);
		expect(optionTitle('a\u2067b\u202Ec')).toBe('\u2068abc\u2069');
		const cut = optionTitle(`\u2067${'y'.repeat(OPTION_TITLE_MAX + 10)}\u2069`);
		expect(cut.match(/[\u2066-\u2069]/g)).toEqual(['\u2068', '\u2069']);
	});
});
