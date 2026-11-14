import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BOOT_SPLASH_ID, BootSplash, removeStaticBootSplash, SPINNER_AFTER_MS, WAITING_AFTER_MS } from './BootSplash';

const renderAt = (path: string) =>
	render(
		<MemoryRouter initialEntries={[path]}>
			<BootSplash />
		</MemoryRouter>
	);

beforeEach(() => {
	vi.useFakeTimers();
	// The delays count from the start of the page load; pretend it has just begun.
	vi.spyOn(performance, 'now').mockReturnValue(0);
});
afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('BootSplash', () => {
	it('shows only the product name at first, never a bare "Loading…" (STA-2, WRD-3)', () => {
		renderAt('/notes');
		expect(screen.getByText('local-llm')).toBeInTheDocument();
		expect(screen.queryByRole('status', { name: 'Loading' })).toBeNull();
		expect(screen.queryByText('Loading…')).toBeNull();
	});

	it('adds a spinner after 400 ms', () => {
		renderAt('/notes');
		act(() => vi.advanceTimersByTime(SPINNER_AFTER_MS - 1));
		expect(screen.queryByRole('status', { name: 'Loading' })).toBeNull();
		act(() => vi.advanceTimersByTime(1));
		expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
	});

	it('says it is still waiting after 8 s, with a retry that comes back to this page', () => {
		renderAt('/notes?tab=all');
		act(() => vi.advanceTimersByTime(WAITING_AFTER_MS - 1));
		expect(screen.queryByText(/Still waiting for the server/)).toBeNull();
		act(() => vi.advanceTimersByTime(1));
		expect(screen.getByText(/Still waiting for the server/)).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Retry' }).getAttribute('href')).toBe(
			`/error?redirect=${encodeURIComponent('/notes?tab=all')}`
		);
	});

	it('counts from the start of the page load, not from when it was drawn', () => {
		vi.mocked(performance.now).mockReturnValue(7900);
		renderAt('/');
		act(() => vi.advanceTimersByTime(100));
		expect(screen.getByText(/Still waiting for the server/)).toBeInTheDocument();
	});

	it('removes the static splash Base.astro draws before scripts run', () => {
		const splash = document.createElement('div');
		splash.id = BOOT_SPLASH_ID;
		document.body.append(splash);
		removeStaticBootSplash();
		expect(document.getElementById(BOOT_SPLASH_ID)).toBeNull();
		expect(() => removeStaticBootSplash()).not.toThrow();
	});
});
