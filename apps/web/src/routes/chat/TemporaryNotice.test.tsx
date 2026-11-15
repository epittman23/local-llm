import { cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { TemporaryNotice, TemporaryToggle, useLeaveWarning } from './TemporaryNotice';

afterEach(() => {
	cleanup();
	delete (window as { lllmDesktop?: unknown }).lllmDesktop;
});

const unload = () => {
	const event = new Event('beforeunload', { cancelable: true });
	window.dispatchEvent(event);
	return event.defaultPrevented;
};

describe('TemporaryToggle', () => {
	it('says its state with aria-pressed and a different icon for on and off (#1080)', () => {
		const onToggle = vi.fn();
		const { rerender } = render(
			<TooltipProvider>
				<TemporaryToggle on={false} onToggle={onToggle} size="icon-sm" />
			</TooltipProvider>
		);
		const toggle = screen.getByRole('button', { name: 'Temporary chat' });
		expect(toggle.getAttribute('aria-pressed')).toBe('false');
		expect(toggle.getAttribute('data-variant')).toBe('ghost');
		expect(screen.getByTestId('temporary-off')).toBeInTheDocument();
		fireEvent.click(toggle);
		expect(onToggle).toHaveBeenCalledTimes(1);

		rerender(
			<TooltipProvider>
				<TemporaryToggle on onToggle={onToggle} size="icon" disabled />
			</TooltipProvider>
		);
		expect(toggle.getAttribute('aria-pressed')).toBe('true');
		expect(toggle.getAttribute('data-variant')).toBe('secondary');
		expect(toggle.getAttribute('data-size')).toBe('icon');
		expect(toggle).toBeDisabled();
		expect(screen.getByTestId('temporary-on')).toBeInTheDocument();
	});
});

describe('TemporaryNotice', () => {
	it('says in words that the chat is not saved, in a plain badge, not a status colour (COL-3)', () => {
		render(<TemporaryNotice />);
		const badge = screen.getByText('Temporary: not saved');
		expect(badge.getAttribute('data-variant')).toBe('secondary');
		expect(badge.querySelector('svg')).not.toBeNull();
	});
});

describe('useLeaveWarning', () => {
	it('asks before a reload or close only while active', () => {
		const { rerender, unmount } = renderHook(({ active }) => useLeaveWarning(active), {
			initialProps: { active: false }
		});
		expect(unload()).toBe(false);
		rerender({ active: true });
		expect(unload()).toBe(true);
		rerender({ active: false });
		expect(unload()).toBe(false);
		rerender({ active: true });
		unmount();
		expect(unload()).toBe(false);
	});

	it('does not ask in the desktop app, whose window would refuse to close', () => {
		(window as { lllmDesktop?: unknown }).lllmDesktop = {};
		renderHook(() => useLeaveWarning(true));
		expect(unload()).toBe(false);
	});
});
