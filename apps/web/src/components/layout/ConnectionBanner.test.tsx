import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useConnectionStore } from '@/lib/socket/connectionStore';
import { ConnectionBanner } from './ConnectionBanner';

describe('ConnectionBanner', () => {
	afterEach(() => {
		useConnectionStore.setState({ lost: false });
		vi.unstubAllGlobals();
	});

	it('shows while the connection is lost and leaves when it is back, in a live region', () => {
		render(<ConnectionBanner />);
		const region = screen.getByRole('status');
		expect(region).toBeEmptyDOMElement();

		act(() => useConnectionStore.getState().setLost(true));
		expect(region).toHaveTextContent("Can't reach the server. Reconnecting…");

		act(() => useConnectionStore.getState().setLost(false));
		expect(region).toBeEmptyDOMElement();
	});

	it('says the computer is offline when the browser knows it is', () => {
		vi.stubGlobal('navigator', { onLine: false });
		useConnectionStore.setState({ lost: true });
		render(<ConnectionBanner />);
		expect(screen.getByRole('status')).toHaveTextContent('This computer is offline. Reconnecting…');
	});
});
