import { act, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorPage, navigation, RETRY_INTERVAL_MS } from './ErrorPage';

const fetchMock = vi.fn();

function renderAt(url: string) {
	const router = createMemoryRouter([{ path: '/error', element: <ErrorPage /> }], { initialEntries: [url] });
	render(<RouterProvider router={router} />);
}

/** Lets the pending fetch and the state updates after it settle. */
const settle = () => act(async () => {});

describe('ErrorPage', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal('fetch', fetchMock);
		vi.spyOn(navigation, 'leaveFor').mockImplementation(() => {});
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		fetchMock.mockReset();
	});

	it('says the server cannot be reached, where, and how to start it', async () => {
		fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
		renderAt('/error');
		await settle();

		expect(screen.getByRole('main')).toBeInTheDocument();
		expect(screen.getByRole('heading', { level: 1, name: "Can't reach the server" })).toBeInTheDocument();
		expect(screen.getByText(new RegExp(`at ${window.location.origin} is not answering`))).toBeInTheDocument();
		expect(screen.getByText('make backend')).toBeInTheDocument();
		expect(screen.getByRole('status')).toHaveTextContent('Last try: no answer. Retrying every 3 seconds…');
	});

	it('names an error status, and asks again every few seconds', async () => {
		fetchMock.mockResolvedValue(new Response('{}', { status: 503 }));
		renderAt('/error');
		await settle();
		expect(screen.getByRole('status')).toHaveTextContent('the server answered with an error (503)');
		expect(fetchMock).toHaveBeenCalledTimes(1);

		await act(async () => vi.advanceTimersByTime(RETRY_INTERVAL_MS));
		expect(fetchMock).toHaveBeenCalledTimes(2);
		await act(async () => vi.advanceTimersByTime(RETRY_INTERVAL_MS));
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(navigation.leaveFor).not.toHaveBeenCalled();
	});

	it('goes back to where the person was going once the server answers', async () => {
		fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
		renderAt('/error?redirect=%2Fnotes%3Fx%3D1');
		await settle();
		expect(navigation.leaveFor).not.toHaveBeenCalled();

		fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
		await act(async () => vi.advanceTimersByTime(RETRY_INTERVAL_MS));
		expect(navigation.leaveFor).toHaveBeenCalledWith('/notes?x=1');
	});

	it('goes home instead of to a redirect off this app', async () => {
		fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
		renderAt('/error?redirect=https%3A%2F%2Fevil.example');
		await settle();
		expect(navigation.leaveFor).toHaveBeenCalledWith('/');
	});

	it('tries at once on Try now, and shows that it is trying', async () => {
		fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
		renderAt('/error');
		await settle();
		expect(fetchMock).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByRole('button', { name: 'Try now' }));
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(screen.getByRole('button', { name: 'Retrying…' })).toHaveAttribute('aria-busy', 'true');
		// A second press while one is in flight asks nothing more.
		fireEvent.click(screen.getByRole('button', { name: 'Retrying…' }));
		expect(fetchMock).toHaveBeenCalledTimes(2);

		await act(async () => vi.advanceTimersByTime(400));
		expect(screen.getByRole('button', { name: 'Try now' })).toBeInTheDocument();
	});
});
