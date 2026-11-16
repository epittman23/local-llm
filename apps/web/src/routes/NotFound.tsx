import { House, Search } from 'lucide-react';
import { Link, useLocation } from 'react-router';
import { Gone } from '@/components/common/Gone';
import { Button } from '@/components/ui/button';
import { useDocumentTitle } from '@/lib/stores/configStore';
import { useUIStore } from '@/lib/stores/uiStore';

/**
 * AppRouter's catch-all ("*") route: the path is not one of this app's routes.
 * It sits inside AppShell, so a mistyped address keeps the sidebar (the route
 * gate sends an anonymous visitor to sign in first), and says so in the
 * middle of the page with ways onward (NAV-3, #1069). It never navigates on
 * its own: the old LegacyFallback bounced unported paths to the SvelteKit
 * app and looped on the dev server. A page that is not found in its own
 * route (Channels while the server has one account) shows it too, and the
 * browser tab says "Page not found" there as well.
 */
export function NotFound() {
	const location = useLocation();
	const setSearchOpen = useUIStore((s) => s.setSearchOpen);
	// Also where a page shows it in its own place (Channels with one account), whose route has another title.
	useDocumentTitle('Page not found');
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
