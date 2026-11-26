import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TEXT_MAX_BYTES } from './limits';
import { useDocumentEdit } from './useDocumentEdit';

const api = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@/lib/apis/files/versions', () => ({ createFileVersion: api.create }));
const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast: toasts }));

const FILE = '00000000-0000-4000-8000-000000000001';
const SAVED = '00000000-0000-4000-8000-000000000002';

function setup(text: string | undefined = 'one\ntwo') {
	const client = new QueryClient();
	const onSaved = vi.fn();
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	const hook = renderHook((props) => useDocumentEdit(props), {
		wrapper,
		initialProps: {
			fileId: FILE as string | null,
			rootId: FILE as string | null,
			text: text as string | undefined,
			onSaved
		}
	});
	return { client, onSaved, hook };
}

beforeEach(() => {
	api.create.mockReset();
	toasts.error.mockReset();
	api.create.mockResolvedValue({ id: SAVED, filename: 'a.py', meta: { version: 2, size: 7 } });
});

describe('useDocumentEdit', () => {
	it('is dirty only while the draft differs from the text: typing and undoing is not a change', () => {
		const { hook } = setup();
		expect(hook.result.current.editing).toBe(false);
		act(() => hook.result.current.start());
		expect(hook.result.current).toMatchObject({ editing: true, draft: 'one\ntwo', dirty: false });
		act(() => hook.result.current.setDraft('one\ntwo!'));
		expect(hook.result.current.dirty).toBe(true);
		act(() => hook.result.current.setDraft('one\ntwo'));
		expect(hook.result.current.dirty).toBe(false);
	});

	it('saves the CRLF the file had, seeds the cache and the version list, and leaves edit mode', async () => {
		const { hook, client, onSaved } = setup('a\r\nb\r\n');
		client.setQueryData(['file-versions', FILE], [{ id: FILE, version: 1, size: 6, created_at: 1, name: 'a.py' }]);
		act(() => hook.result.current.start());
		expect(hook.result.current.draft).toBe('a\nb\n');
		act(() => hook.result.current.setDraft('a\nb\nc\n'));
		await act(() => hook.result.current.save());
		expect(api.create).toHaveBeenCalledWith('', FILE, 'a\r\nb\r\nc\r\n');
		expect(client.getQueryData(['sandbox-output-text', SAVED, TEXT_MAX_BYTES])).toEqual({
			text: 'a\r\nb\r\nc\r\n',
			truncated: false
		});
		expect(client.getQueryData<{ id: string }[]>(['file-versions', FILE])?.map((v) => v.id)).toEqual([FILE, SAVED]);
		expect(hook.result.current).toMatchObject({ editing: false, saving: false });
		expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: SAVED }));
	});

	it('keeps the draft and the editor when the save fails, and can be pressed again', async () => {
		api.create.mockRejectedValueOnce({ detail: 'Not found' });
		const { hook, onSaved } = setup();
		act(() => hook.result.current.start());
		act(() => hook.result.current.setDraft('changed'));
		await act(() => hook.result.current.save());
		expect(hook.result.current).toMatchObject({ editing: true, draft: 'changed', dirty: true, saving: false });
		expect(toasts.error).toHaveBeenCalledTimes(1);
		expect(onSaved).not.toHaveBeenCalled();
		await act(() => hook.result.current.save());
		expect(api.create).toHaveBeenCalledTimes(2);
		expect(hook.result.current.editing).toBe(false);
	});

	it('refuses a text over the limit before any request, and an empty draft', async () => {
		const { hook } = setup();
		act(() => hook.result.current.start());
		act(() => hook.result.current.setDraft('é'.repeat(TEXT_MAX_BYTES / 2 + 1)));
		await act(() => hook.result.current.save());
		expect(toasts.error).toHaveBeenCalledWith('Too large to save: 256 KiB at most');
		act(() => hook.result.current.setDraft(''));
		expect(hook.result.current.blocked).toBe('A document can’t be saved empty');
		await act(() => hook.result.current.save());
		expect(api.create).not.toHaveBeenCalled();
	});

	it('makes one request for a double press', async () => {
		let release: (v: unknown) => void = () => {};
		api.create.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
		const { hook } = setup();
		act(() => hook.result.current.start());
		act(() => hook.result.current.setDraft('changed'));
		let first: Promise<void> = Promise.resolve();
		act(() => {
			first = hook.result.current.save();
			void hook.result.current.save();
		});
		expect(hook.result.current.saving).toBe(true);
		release({ id: SAVED, meta: { version: 2 } });
		await act(() => first);
		expect(api.create).toHaveBeenCalledTimes(1);
	});

	it('ends editing when the file shown changes, and does not bring the draft back', async () => {
		const { hook } = setup();
		act(() => hook.result.current.start());
		act(() => hook.result.current.setDraft('changed'));
		hook.rerender({ fileId: null, rootId: null, text: undefined, onSaved: vi.fn() });
		await waitFor(() => expect(hook.result.current.editing).toBe(false));
		hook.rerender({ fileId: FILE, rootId: FILE, text: 'one\ntwo', onSaved: vi.fn() });
		expect(hook.result.current).toMatchObject({ editing: false, dirty: false, draft: 'one\ntwo' });
	});
});
