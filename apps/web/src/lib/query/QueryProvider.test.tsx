import { onlineManager, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from './QueryProvider';

afterEach(() => onlineManager.setOnline(true));

function Probe({ queryFn }: { queryFn: () => Promise<string> }) {
	const { data } = useQuery({ queryKey: ['probe'], queryFn });
	return <p>{data ?? 'loading'}</p>;
}

const show = (queryFn: () => Promise<string>) => {
	const client = createQueryClient();
	render(
		<QueryClientProvider client={client}>
			<Probe queryFn={queryFn} />
		</QueryClientProvider>
	);
};

describe('createQueryClient (#1123)', () => {
	it("never pauses queries or mutations for the browser's offline state", () => {
		const defaults = createQueryClient().getDefaultOptions();
		expect(defaults.queries?.networkMode).toBe('always');
		expect(defaults.mutations?.networkMode).toBe('always');
		expect(defaults.queries?.refetchOnReconnect).toBe(true);
		expect(defaults.queries?.retry).toBe(1);
		expect(defaults.queries?.refetchOnWindowFocus).toBe(false);
	});

	it('runs a query while the browser is offline', async () => {
		onlineManager.setOnline(false);
		show(() => Promise.resolve('loaded'));
		expect(await screen.findByText('loaded')).toBeInTheDocument();
	});

	it('still refetches an active query when the connection comes back (#981)', async () => {
		const queryFn = vi.fn().mockResolvedValue('loaded');
		onlineManager.setOnline(false);
		show(queryFn);
		await screen.findByText('loaded');
		expect(queryFn).toHaveBeenCalledTimes(1);

		act(() => onlineManager.setOnline(true));
		await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2));
	});
});
