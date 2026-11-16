import {
	Component,
	type ComponentType,
	type LazyExoticComponent,
	lazy,
	type ReactNode,
	Suspense,
	useState
} from 'react';
import { Spinner } from '@/components/common/Spinner';
import { Button } from '@/components/ui/button';
import { tabLoaders } from './adminTabComponents';

const lazyTabs = new Map<string, LazyExoticComponent<ComponentType>>();

/** The lazy component for a tab; a higher `attempt` makes a fresh one, so a failed import is retried. */
function lazyTab(id: string, attempt: number) {
	const key = `${id}:${attempt}`;
	let tab = lazyTabs.get(key);
	if (!tab) {
		tab = lazy(tabLoaders[id]);
		lazyTabs.set(key, tab);
	}
	return tab;
}

/** Keeps a tab that fails to load (server down, stale build) from taking the page down with it. */
class TabErrorBoundary extends Component<{ onRetry: () => void; children: ReactNode }, { failed: boolean }> {
	state = { failed: false };

	static getDerivedStateFromError() {
		return { failed: true };
	}

	render() {
		if (!this.state.failed) return this.props.children;
		return (
			<div role="alert" className="flex h-full flex-col items-center justify-center gap-3 text-center">
				<p className="text-foreground-muted">This tab could not be loaded. Check your connection to the server.</p>
				<Button variant="secondary" size="sm" type="button" onClick={this.props.onRetry}>
					Retry
				</Button>
			</div>
		);
	}
}

/**
 * A settings tab's component, fetched when first shown (#836): a spinner while
 * it loads, and a message with Retry if it cannot be. Shared by the Settings
 * dialog and the admin settings pages (S5-D1).
 */
export function SettingsTabContent({ id }: { id: string }) {
	const [attempts, setAttempts] = useState<Record<string, number>>({});
	if (!tabLoaders[id]) return null;
	const attempt = attempts[id] ?? 0;
	const Active = lazyTab(id, attempt);
	return (
		<TabErrorBoundary key={`${id}:${attempt}`} onRetry={() => setAttempts((a) => ({ ...a, [id]: (a[id] ?? 0) + 1 }))}>
			<Suspense
				fallback={
					<div className="flex h-full items-center justify-center">
						<Spinner className="size-6" />
					</div>
				}
			>
				<Active key={id} />
			</Suspense>
		</TabErrorBoundary>
	);
}
