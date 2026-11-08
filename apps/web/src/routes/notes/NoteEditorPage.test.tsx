import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { updateNoteById } from '@/lib/apis/notes';
import { useAuthStore } from '@/lib/stores/authStore';
import { useNoteSaver } from './NoteEditorPage';

vi.mock('@/lib/apis/notes', () => ({ updateNoteById: vi.fn(async () => ({})) }));

const wrapper = ({ children }: { children: ReactNode }) => (
	<QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
);

beforeEach(() => {
	useAuthStore.setState({ token: 't' } as never);
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
});

describe('useNoteSaver', () => {
	it('saves the last edit after the pause, without keepalive', () => {
		const { result } = renderHook(() => useNoteSaver('n1'), { wrapper });
		act(() => {
			result.current.schedule('A', null);
			result.current.schedule('AB', null);
		});
		act(() => void vi.advanceTimersByTime(500));
		expect(updateNoteById).toHaveBeenCalledExactlyOnceWith('t', 'n1', { title: 'AB', data: {} }, false);
	});

	it('saves a pending edit as the page goes away, with keepalive, and only once (#675)', () => {
		const { result, unmount } = renderHook(() => useNoteSaver('n1'), { wrapper });
		act(() => result.current.schedule('Draft', null));
		act(() => void window.dispatchEvent(new Event('pagehide')));
		expect(updateNoteById).toHaveBeenCalledExactlyOnceWith('t', 'n1', { title: 'Draft', data: {} }, true);
		act(() => void vi.advanceTimersByTime(500));
		unmount();
		window.dispatchEvent(new Event('pagehide'));
		expect(updateNoteById).toHaveBeenCalledTimes(1);
	});
});
