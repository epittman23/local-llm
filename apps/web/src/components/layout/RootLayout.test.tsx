import { act, cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, Link, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useConfigStore, useDocumentTitle } from '@/lib/stores/configStore';
import { usePageTitleStore } from '@/lib/ui/pageTitle';
import { RootLayout } from './RootLayout';

const installSystemThemeListener = vi.hoisted(() => vi.fn(() => vi.fn()));
vi.mock('@/lib/theme', () => ({ installSystemThemeListener }));

function Chat({ title }: { title: string | null }) {
	useDocumentTitle(title);
	return <p>chat</p>;
}

function renderAt(path: string, chatTitle: string | null = 'Sample variance walkthrough') {
	const router = createMemoryRouter(
		[
			{
				element: <RootLayout />,
				children: [
					{
						path: '/benchmarks/serve',
						element: <Link to="/c/1">open chat</Link>,
						handle: { title: 'Serve', heading: 'layout' }
					},
					{ path: '/c/:id', element: <Chat title={chatTitle} />, handle: { title: 'Chat', heading: 'sr' } },
					{ path: '/auth', element: <p>sign in</p>, handle: { title: 'Sign in', heading: 'page' } },
					{ path: '/bare', element: <p>bare</p> }
				]
			}
		],
		{ initialEntries: [path] }
	);
	render(<RouterProvider router={router} />);
	return router;
}

beforeEach(() => {
	document.title = 'local-llm';
	useConfigStore.setState({ config: null });
});
afterEach(() => {
	cleanup();
	usePageTitleStore.setState({ dynamic: null, owner: null });
	installSystemThemeListener.mockClear();
});

describe('RootLayout', () => {
	it('titles the tab with the route’s page name and the product (LAY-5)', () => {
		renderAt('/benchmarks/serve');
		expect(document.title).toBe('Serve · local-llm');
	});

	it('uses the page’s own name while it is mounted, and the route’s again after it leaves', async () => {
		const router = renderAt('/benchmarks/serve');
		await act(() => router.navigate('/c/1'));
		expect(screen.getByText('chat')).toBeInTheDocument();
		expect(document.title).toBe('Sample variance walkthrough · local-llm');
		await act(() => router.navigate('/benchmarks/serve'));
		expect(document.title).toBe('Serve · local-llm');
	});

	it('falls back to the route’s name when the page gives none (chat title not shown in the tab)', () => {
		renderAt('/c/1', null);
		expect(document.title).toBe('Chat · local-llm');
	});

	it('titles public routes too, and shows the bare name for a route without one', async () => {
		const router = renderAt('/auth');
		expect(document.title).toBe('Sign in · local-llm');
		await act(() => router.navigate('/bare'));
		expect(document.title).toBe('local-llm');
	});

	it('follows the configured instance name', () => {
		useConfigStore.setState({ config: { name: 'lab box', version: '0' } });
		renderAt('/auth');
		expect(document.title).toBe('Sign in · lab box');
	});

	it('takes down the static boot splash and installs the system theme listener once', async () => {
		const splash = document.createElement('div');
		splash.id = 'boot-splash';
		document.body.append(splash);
		const router = renderAt('/auth');
		expect(document.getElementById('boot-splash')).toBeNull();
		await act(() => router.navigate('/bare'));
		expect(installSystemThemeListener).toHaveBeenCalledTimes(1);
	});
});
