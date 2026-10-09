import { Calendar, NotebookText } from 'lucide-react';
import { Link } from 'react-router';
import { canUseFeature } from '@/lib/access/features';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore, useDocumentTitle } from '@/lib/stores/configStore';
import { routePaths } from '@/routes/routePaths';

/**
 * Ports routes/(app)/home. In the Svelte app this is an unfinished stub: a
 * layout whose two tabs, "Notes" and "Calendar", link to /playground/notes
 * and /playground/completions (neither is a real page), over an empty page.
 * Nothing links to it. Kept as a route so the URL still resolves, with the
 * two tabs pointed where their labels say, each shown only to someone who
 * may use it.
 */
export function HomePage() {
	const user = useAuthStore((s) => s.user);
	const config = useConfigStore((s) => s.config);
	useDocumentTitle('Home');
	const links = [
		{ to: routePaths.notes, label: 'Notes', icon: NotebookText, show: canUseFeature('notes', user, config) },
		{ to: routePaths.calendar, label: 'Calendar', icon: Calendar, show: canUseFeature('calendar', user, config) }
	].filter((l) => l.show);

	return (
		<div className="flex flex-col gap-4 p-6">
			<h1 className="text-xl font-semibold">Home</h1>
			{links.length ? (
				<nav className="flex gap-2" aria-label="Home">
					{links.map(({ to, label, icon: Icon }) => (
						<Link
							key={to}
							to={to}
							className="hover:bg-muted flex items-center gap-2 rounded-xl border px-4 py-3 text-sm"
						>
							<Icon className="size-4" />
							{label}
						</Link>
					))}
				</nav>
			) : (
				<p className="text-muted-foreground text-sm">Nothing here yet.</p>
			)}
		</div>
	);
}
