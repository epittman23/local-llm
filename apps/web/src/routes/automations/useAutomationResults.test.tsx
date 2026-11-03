import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAutomationResults } from './useAutomationResults';

const { socket, invalidateQueries } = vi.hoisted(() => ({
	socket: { on: vi.fn(), off: vi.fn() },
	invalidateQueries: vi.fn()
}));
vi.mock('@/lib/socket/SocketProvider', () => ({ useSocket: () => ({ socket, connected: true }) }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries }) }));

/** The handler the hook registered for `automation:result`. */
const handler = () => {
	const call = socket.on.mock.calls.find(([name]) => name === 'automation:result');
	if (!call) throw new Error('no automation:result listener');
	return call[1] as (result: unknown) => void;
};

describe('useAutomationResults', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('refetches the automation and its runs when one of its runs ends', () => {
		renderHook(() => useAutomationResults('auto-1'));
		handler()({ automation_id: 'auto-1', status: 'error' });
		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['automations', 'runs', 'auto-1'] });
		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['automations', 'item', 'auto-1'] });
	});

	it("ignores another automation's result", () => {
		renderHook(() => useAutomationResults('auto-1'));
		handler()({ automation_id: 'auto-2', status: 'success' });
		expect(invalidateQueries).not.toHaveBeenCalled();
	});

	it('stops listening when it unmounts', () => {
		const { unmount } = renderHook(() => useAutomationResults('auto-1'));
		const registered = handler();
		unmount();
		expect(socket.off).toHaveBeenCalledWith('automation:result', registered);
	});
});
