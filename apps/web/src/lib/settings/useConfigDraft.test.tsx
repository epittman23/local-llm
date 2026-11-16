import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { describe, expect, it, vi } from 'vitest';
import { sameSettings, useConfigDraft } from './useConfigDraft';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const wrapper = ({ children }: { children: ReactNode }) => (
	<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
		{children}
	</QueryClientProvider>
);

describe('useConfigDraft', () => {
	it('treats a load that resolves to nothing as a failure, not a spinner (#240)', async () => {
		const { result } = renderHook(() => useConfigDraft(['nothing'], async () => null), { wrapper });
		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(result.current.isLoading).toBe(false);
		expect(result.current.draft).toBeNull();
		expect(toast.error).toHaveBeenCalledWith('Could not load these settings');
	});

	it('seeds the draft from a successful load', async () => {
		const { result } = renderHook(() => useConfigDraft(['some'], async () => ({ enabled: true })), { wrapper });
		await waitFor(() => expect(result.current.draft).toEqual({ enabled: true }));
		expect(result.current.isError).toBe(false);
	});
});

describe('useConfigDraft: unsaved changes (#951)', () => {
	const load = () =>
		renderHook(() => useConfigDraft(['dirty'], async () => ({ a: 1, b: '', nested: { x: true } })), { wrapper });

	it('is clean as loaded, dirty after an edit, and clean again after Discard', async () => {
		const { result } = load();
		await waitFor(() => expect(result.current.draft).not.toBeNull());
		expect(result.current.dirty).toBe(false);
		act(() => result.current.patch({ a: 2 }));
		expect(result.current.dirty).toBe(true);
		act(() => result.current.discard());
		expect(result.current.draft).toEqual({ a: 1, b: '', nested: { x: true } });
		expect(result.current.dirty).toBe(false);
	});

	it('takes an emptied box and a reordered object as no change', async () => {
		const { result } = load();
		await waitFor(() => expect(result.current.draft).not.toBeNull());
		act(() => result.current.setDraft({ nested: { x: true }, b: null as never, a: 1 }));
		expect(result.current.dirty).toBe(false);
	});

	it('commit makes what was sent the saved state; with show it also replaces the draft', async () => {
		const { result } = load();
		await waitFor(() => expect(result.current.draft).not.toBeNull());
		act(() => result.current.patch({ a: 3 }));
		act(() => result.current.commit(result.current.draft as never));
		expect(result.current.dirty).toBe(false);
		expect(result.current.saved).toEqual({ a: 3, b: '', nested: { x: true } });
		act(() => result.current.commit({ a: 4, b: 'x', nested: { x: false } }, true));
		expect(result.current.draft).toEqual({ a: 4, b: 'x', nested: { x: false } });
		expect(result.current.dirty).toBe(false);
	});

	it('reload resets both the draft and the saved state', async () => {
		const { result } = load();
		await waitFor(() => expect(result.current.draft).not.toBeNull());
		act(() => result.current.patch({ a: 9 }));
		await act(() => result.current.reload());
		expect(result.current.dirty).toBe(false);
		expect(result.current.draft).toEqual({ a: 1, b: '', nested: { x: true } });
	});
});

describe('sameSettings', () => {
	it('compares by value, ignoring key order and empty values', () => {
		expect(sameSettings({ a: [1, { b: 2, c: '' }] }, { a: [1, { b: 2 }] })).toBe(true);
		expect(sameSettings({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
		expect(sameSettings({ a: 0 }, { a: null })).toBe(false);
	});
});
