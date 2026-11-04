import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useOnChatSwitch } from './useOnChatSwitch';

// #217: files attached and text typed in one chat were sent into the next one opened,
// since the chat page stays mounted across /c/:id. They are cleared on a switch,
// but kept when a chat started here takes on its id.

function setup(chatId: string | null, adoptedChatId: string | null = null) {
	const reset = vi.fn();
	const hook = renderHook(
		(p: { chatId: string | null; adoptedChatId: string | null }) => useOnChatSwitch(p.chatId, p.adoptedChatId, reset),
		{ initialProps: { chatId, adoptedChatId } }
	);
	return { reset, rerender: hook.rerender };
}

describe('useOnChatSwitch', () => {
	it('does nothing when the chat is first opened', () => {
		const { reset } = setup('A');
		expect(reset).not.toHaveBeenCalled();
	});

	it('resets when another chat opens', () => {
		const { reset, rerender } = setup('A');
		rerender({ chatId: 'B', adoptedChatId: null });
		expect(reset).toHaveBeenCalledTimes(1);
	});

	it('resets when leaving a chat for a new one', () => {
		const { reset, rerender } = setup('A');
		rerender({ chatId: null, adoptedChatId: null });
		expect(reset).toHaveBeenCalledTimes(1);
	});

	it('keeps them when a chat started here takes on its id', () => {
		const { reset, rerender } = setup(null);
		rerender({ chatId: 'new', adoptedChatId: 'new' });
		expect(reset).not.toHaveBeenCalled();
	});

	it('does not reset again on a re-render of the same chat', () => {
		const { reset, rerender } = setup('A');
		rerender({ chatId: 'B', adoptedChatId: null });
		rerender({ chatId: 'B', adoptedChatId: null });
		expect(reset).toHaveBeenCalledTimes(1);
	});

	it('resets when a chat is opened from a new one', () => {
		const { reset, rerender } = setup(null);
		rerender({ chatId: 'B', adoptedChatId: null });
		expect(reset).toHaveBeenCalledTimes(1);
	});

	it('resets when the chat opened is not the one adopted', () => {
		const { reset, rerender } = setup(null);
		rerender({ chatId: 'Y', adoptedChatId: 'X' });
		expect(reset).toHaveBeenCalledTimes(1);
	});
});
