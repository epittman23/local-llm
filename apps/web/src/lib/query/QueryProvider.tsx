import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';

/**
 * The app's QueryClient. networkMode 'always' because the server is on this
 * machine or the LAN and stays reachable while the browser reports offline
 * (navigator.onLine is false), where the default 'online' would pause every
 * query and leave lists loading (#1123). refetchOnReconnect is set to true
 * explicitly: TanStack's default turns it off under networkMode 'always', and
 * lists should still refetch when the connection returns (#981).
 */
export function createQueryClient() {
	return new QueryClient({
		defaultOptions: {
			queries: {
				networkMode: 'always',
				refetchOnReconnect: true,
				retry: 1,
				refetchOnWindowFocus: false
			},
			mutations: {
				networkMode: 'always'
			}
		}
	});
}

/**
 * One QueryClient per mounted app root (see src/components/App.tsx), not a
 * module singleton -- useState's lazy initializer keeps it stable across
 * re-renders without surviving a real remount, matching TanStack Query's own
 * SSR/StrictMode guidance even though this app has no SSR yet.
 */
export function QueryProvider({ children }: { children: React.ReactNode }) {
	const [client] = useState(createQueryClient);

	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
