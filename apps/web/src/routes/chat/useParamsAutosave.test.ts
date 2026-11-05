import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { updateChatById } from '@/lib/apis/chats';
import { useParamsAutosave } from './useParamsAutosave';

vi.mock('@/lib/apis/chats', () => ({ updateChatById: vi.fn(async () => ({})) }));

const render = (chatId: string | null) =>
	renderHook(({ id }) => useParamsAutosave(id, 'tok'), { initialProps: { id: chatId } });

describe('useParamsAutosave', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => {
		vi.useRealTimers();
		vi.mocked(updateChatById).mockClear();
	});

	it('saves the last edit to its chat after the pause', () => {
		const { result } = render('c1');
		act(() => {
			result.current({ temperature: 0.1 });
			result.current({ temperature: 0.2 });
		});
		expect(updateChatById).not.toHaveBeenCalled();
		act(() => void vi.advanceTimersByTime(500));
		expect(updateChatById).toHaveBeenCalledExactlyOnceWith('tok', 'c1', { params: { temperature: 0.2 } });
	});

	it('saves a pending edit to its own chat at once when another chat opens', () => {
		const { result, rerender } = render('c1');
		act(() => result.current({ system: 'French' }));
		rerender({ id: 'c2' });
		expect(updateChatById).toHaveBeenCalledExactlyOnceWith('tok', 'c1', { params: { system: 'French' } });
		act(() => void vi.advanceTimersByTime(500));
		expect(updateChatById).toHaveBeenCalledTimes(1);
	});

	it('saves a pending edit when the page unmounts (#525)', () => {
		const { result, unmount } = render('c1');
		act(() => result.current({ system: 'French' }));
		unmount();
		expect(updateChatById).toHaveBeenCalledExactlyOnceWith('tok', 'c1', { params: { system: 'French' } });
	});

	it('saves nothing for a new chat, whose params go with its first message', () => {
		const { result, unmount } = render(null);
		act(() => result.current({ system: 'French' }));
		act(() => void vi.advanceTimersByTime(500));
		unmount();
		expect(updateChatById).not.toHaveBeenCalled();
	});
});
