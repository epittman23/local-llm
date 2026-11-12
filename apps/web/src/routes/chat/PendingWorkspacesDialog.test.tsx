import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PENDING_WORKSPACE_IDS_KEY, type PendingWorkspace } from '@/lib/apis/sandbox';
import { useAuthStore } from '@/lib/stores/authStore';
import { PendingWorkspacesDialog } from './PendingWorkspacesDialog';

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
			within(cap).getByText(/"New report" needs a code workspace, and you have the most allowed \(20\)/)
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
		fireEvent.click(within(cap).getByRole('button', { name: 'Remove' }));
		await waitFor(() => expect(screen.queryByRole('region', { name: 'Workspace of Untitled chat' })).toBeNull());
		expect(calls.filter((c) => c.method === 'POST')).toEqual([
			{ url: '/api/v1/sandbox/pending/w-lru', method: 'POST', body: { action: 'remove', workspace: 'w-other' } }
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
		fireEvent.click(within(old).getByRole('button', { name: 'Keep' }));
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ action: 'keep' });
		expect(toastSuccess).toHaveBeenCalledWith('Workspace kept.');
	});

	it('says why an answer failed and keeps the item', async () => {
		answer = () => Response.json({ detail: "The workspace's chat is running code" }, { status: 409 });
		renderDialog();
		const old = await screen.findByRole('region', { name: 'Workspace of Old analysis' });
		fireEvent.click(within(old).getByRole('button', { name: 'Remove' }));
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
});
