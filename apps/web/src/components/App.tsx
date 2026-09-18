import { TooltipProvider } from '@/components/ui/tooltip';
import { AuthProvider } from '@/lib/auth/AuthProvider';
import { I18nProvider } from '@/lib/i18n/I18nProvider';
import { QueryProvider } from '@/lib/query/QueryProvider';
import { SocketProvider } from '@/lib/socket/SocketProvider';
import { AppRouter } from '@/routes/AppRouter';

/**
 * The persistent React root Astro mounts once (see src/pages/index.astro).
 * Provider order, outside in: i18n and query have no dependency on auth;
 * SocketProvider reads the auth store directly (it re-connects when the
 * token changes, see its own effect), so it nests inside AuthProvider
 * without needing prop drilling.
 */
export default function App() {
	return (
		<I18nProvider>
			<QueryProvider>
				<AuthProvider>
					<SocketProvider>
						<TooltipProvider>
							<AppRouter />
						</TooltipProvider>
					</SocketProvider>
				</AuthProvider>
			</QueryProvider>
		</I18nProvider>
	);
}
