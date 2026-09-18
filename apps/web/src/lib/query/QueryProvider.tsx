import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';

/**
 * One QueryClient per mounted app root (see src/components/App.tsx), not a
 * module singleton -- useState's lazy initializer keeps it stable across
 * re-renders without surviving a real remount, matching TanStack Query's own
 * SSR/StrictMode guidance even though this app has no SSR yet.
 */
export function QueryProvider({ children }: { children: React.ReactNode }) {
	const [client] = useState(
		() =>
			new QueryClient({
				defaultOptions: {
					queries: {
						retry: 1,
						refetchOnWindowFocus: false
					}
				}
			})
	);

	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
