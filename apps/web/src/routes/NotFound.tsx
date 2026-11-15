import { House, Search } from 'lucide-react';
import { Link, useLocation } from 'react-router';
import { Gone } from '@/components/common/Gone';
import { Button } from '@/components/ui/button';
import { useUIStore } from '@/lib/stores/uiStore';

/**
 * AppRouter's catch-all ("*") route: the path is not one of this app's routes.
 * It sits inside AppShell, so a mistyped address keeps the sidebar (the route
 * gate sends an anonymous visitor to sign in first), and says so in the
 * middle of the page with ways onward (NAV-3, #1069). It never navigates on
 * its own: the old LegacyFallback bounced unported paths to the SvelteKit
 * app and looped on the dev server.
 */
export function NotFound() {
	const location = useLocation();
	const setSearchOpen = useUIStore((s) => s.setSearchOpen);
	return (
		<div className="flex h-full min-h-0 flex-col justify-center">
			<Gone
				title="Page not found"
				description={
					<>
						Nothing lives at <code className="font-code break-all">{location.pathname}</code>.
					</>
				}
				actions={
					<>
						<Button asChild>
							<Link to="/">
								<House aria-hidden /> Go home
							</Link>
						</Button>
						<Button variant="outline" onClick={() => setSearchOpen(true)}>
							<Search aria-hidden /> Search chats
						</Button>
					</>
				}
			/>
		</div>
	);
}
