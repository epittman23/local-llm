import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { blockDoc, docOf, id, output, upload } from './testing';
import { useDocumentVersions } from './useDocumentVersions';

const api = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('@/lib/apis/files/versions', () => ({ listFileVersions: api.list }));

const client = new QueryClient();
const wrapper = ({ children }: { children: ReactNode }) => (
	<QueryClientProvider client={client}>{children}</QueryClientProvider>
);
const entry = (key: string, version: number) => ({ id: id(key), version, size: 3, created_at: 1, name: 'fit.py' });

beforeEach(() => {
	api.list.mockReset();
	client.clear();
});

describe('useDocumentVersions', () => {
	it('lists the versions of an editable document by its original’s id, the last being the latest', async () => {
		api.list.mockResolvedValue([entry('1', 1), entry('2', 2)]);
		const { result } = renderHook(() => useDocumentVersions(docOf(output('1', 'fit.py'))), { wrapper });
		await waitFor(() => expect(result.current.versions).toHaveLength(2));
		expect(result.current.latest?.id).toBe(id('2'));
		expect(api.list).toHaveBeenCalledWith('', id('1'), expect.any(AbortSignal));
	});

	it('asks nothing for a block, a table or an image, nor when disabled', () => {
		for (const doc of [
			blockDoc('x = 1', 'python'),
			docOf(output('1', 'table.csv')),
			docOf(upload('2', 'a.png'), 'user')
		])
			renderHook(() => useDocumentVersions(doc), { wrapper });
		renderHook(() => useDocumentVersions(docOf(output('1', 'fit.py')), false), { wrapper });
		renderHook(() => useDocumentVersions(null), { wrapper });
		expect(api.list).not.toHaveBeenCalled();
	});

	it('treats a failed request as no versions, so the viewer keeps working', async () => {
		api.list.mockRejectedValue({ detail: 'down' });
		const { result } = renderHook(() => useDocumentVersions(docOf(output('1', 'fit.py'))), { wrapper });
		await waitFor(() => expect(result.current.loading).toBe(false));
		expect(result.current).toEqual({ versions: [], latest: null, loading: false });
	});
});
