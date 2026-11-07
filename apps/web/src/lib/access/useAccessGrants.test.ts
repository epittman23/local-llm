import { act, renderHook, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AccessGrant, DROPPED_GRANTS_WARNING } from './accessGrants';
import { useAccessGrants } from './useAccessGrants';

const grant = (principal_id: string): AccessGrant => ({ principal_type: 'user', principal_id, permission: 'read' });
const ids = (grants: AccessGrant[]) => grants.map((g) => g.principal_id).join(',');
type Reply = { access_grants?: unknown } | null;

afterEach(() => vi.restoreAllMocks());

describe('useAccessGrants', () => {
	it('shows the sent grants at once, before the server answers', () => {
		const { result } = renderHook(() => useAccessGrants([], () => new Promise<Reply>(() => undefined)));

		act(() => void result.current[1]([grant('a')]));

		expect(ids(result.current[0])).toBe('a');
	});

	it('shows the grants the server stored, and warns instead of saying Saved when it dropped some', async () => {
		const warning = vi.spyOn(toast, 'warning');
		const success = vi.spyOn(toast, 'success');
		const { result } = renderHook(() => useAccessGrants([], async () => ({ access_grants: [grant('a')] })));

		await act(() => result.current[1]([grant('a'), grant('*')]));

		expect(ids(result.current[0])).toBe('a');
		expect(warning).toHaveBeenCalledWith(DROPPED_GRANTS_WARNING);
		expect(success).not.toHaveBeenCalled();
	});

	it('says Saved when the server kept every grant', async () => {
		const success = vi.spyOn(toast, 'success');
		const { result } = renderHook(() => useAccessGrants([], async () => ({ access_grants: [grant('a')] })));

		await act(() => result.current[1]([grant('a')]));

		expect(success).toHaveBeenCalledWith('Saved');
		expect(ids(result.current[0])).toBe('a');
	});

	it('keeps the sent grants when the reply has no grant list', async () => {
		const success = vi.spyOn(toast, 'success');
		const { result } = renderHook(() => useAccessGrants([], async () => ({})));

		await act(() => result.current[1]([grant('a')]));

		expect(ids(result.current[0])).toBe('a');
		expect(success).toHaveBeenCalledWith('Saved');
	});

	it('shows only the latest of two saves whose answers arrive in reverse order', async () => {
		const answers: ((v: Reply) => void)[] = [];
		const { result } = renderHook(() =>
			useAccessGrants([], () => new Promise<Reply>((resolve) => answers.push(resolve)))
		);
		act(() => void result.current[1]([grant('a')]));
		act(() => void result.current[1]([grant('b')]));

		await act(async () => answers[1]({ access_grants: [grant('b')] }));
		await act(async () => answers[0]({ access_grants: [grant('a')] }));

		expect(ids(result.current[0])).toBe('b');
	});

	it('puts the previous grants back when the latest save fails, and says why', async () => {
		const error = vi.spyOn(toast, 'error');
		const { result } = renderHook(() => useAccessGrants([grant('x')], () => Promise.reject('Not allowed')));

		await act(() => result.current[1]([grant('a')]));

		expect(error).toHaveBeenCalledWith('Not allowed');
		expect(ids(result.current[0])).toBe('x');
	});

	it('leaves a newer save alone when an older one fails', async () => {
		let failFirst: (e: unknown) => void = () => undefined;
		const save = vi
			.fn<(grants: AccessGrant[]) => Promise<Reply>>()
			.mockImplementationOnce(() => new Promise((_resolve, reject) => (failFirst = reject)))
			.mockResolvedValueOnce({ access_grants: [grant('b')] });
		const { result } = renderHook(() => useAccessGrants([], save));
		act(() => void result.current[1]([grant('a')]));
		await act(() => result.current[1]([grant('b')]));

		await act(async () => failFirst('offline'));

		await waitFor(() => expect(ids(result.current[0])).toBe('b'));
	});

	it('only keeps the grants when there is nothing to save them to yet', async () => {
		const success = vi.spyOn(toast, 'success');
		const { result } = renderHook(() => useAccessGrants([], null));

		await act(() => result.current[1]([grant('a')]));

		expect(ids(result.current[0])).toBe('a');
		expect(success).not.toHaveBeenCalled();
	});
});
