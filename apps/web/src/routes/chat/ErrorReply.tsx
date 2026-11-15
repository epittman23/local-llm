import { CircleAlert, RotateCcw } from 'lucide-react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import type { Message } from '@/lib/chat/history';
import { useAuthStore } from '@/lib/stores/authStore';
import { useSettingsModalStore } from '@/lib/stores/settingsModalStore';
import { routePaths } from '@/routes/routePaths';

// failMessage() (lib/chat/history.ts) stores this sentence before the cause; the
// heading says it better, so it is left out of what is shown (the stored text stays).
const STORED_PREFIX = /^Uh-oh! There was an issue with the response\.\s*/;

/** The upstream sentence of a reply's error, or '' when it has none. */
export function errorDetail(message: Message): string {
	const content = message.error?.content;
	return typeof content === 'string' ? content.replace(STORED_PREFIX, '').trim() : '';
}

/** What to do next for the failures we recognise by their wording: a refused key, or llama-server not serving. */
export function errorHint(text: string): 'key' | 'local' | null {
	if (/\b401\b|unauthori[sz]ed|api[ _-]?key|\bkey\b/i.test(text)) return 'key';
	if (/connection refused|econnrefused|connect call failed|cannot connect to host|:8090\b/i.test(text)) return 'local';
	return null;
}

/**
 * A reply that failed (FBK-4, STA-4): what happened, the provider's own words,
 * what to do for the known causes, and the two ways on: Retry (regenerate) and,
 * where the page can open the model picker, Try another model.
 */
export function ErrorReply({
	message,
	onRetry,
	onTryAnotherModel
}: {
	message: Message;
	onRetry?: () => void;
	onTryAnotherModel?: () => void;
}) {
	const admin = useAuthStore((s) => s.user?.role === 'admin');
	const openSettings = useSettingsModalStore((s) => s.openSettings);
	const detail = errorDetail(message);
	const hint = errorHint(detail);
	return (
		<div className="border-danger bg-surface-1 my-2 flex gap-2 rounded-panel border p-3" role="alert">
			<CircleAlert className="text-danger mt-0.5 size-4 shrink-0" aria-hidden />
			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<p className="text-body font-strong">The model didn't answer</p>
				<p className="text-body text-foreground-strong break-words whitespace-pre-wrap">
					{detail || 'The provider gave no reason.'}
				</p>
				{hint === 'key' && (
					<p className="text-body text-foreground-muted">Check the API key in Admin Settings &gt; Connections.</p>
				)}
				{hint === 'local' && (
					<p className="text-body text-foreground-muted">
						The local server is not running. Start it from Benchmarks &gt; Serve.
					</p>
				)}
				<div className="mt-1 flex flex-wrap gap-2">
					{onRetry && (
						<Button type="button" variant="outline" size="sm" onClick={onRetry}>
							<RotateCcw aria-hidden />
							Retry
						</Button>
					)}
					{onTryAnotherModel && (
						<Button type="button" variant="ghost" size="sm" onClick={onTryAnotherModel}>
							Try another model
						</Button>
					)}
					{hint === 'key' && admin && (
						<Button type="button" variant="ghost" size="sm" onClick={() => openSettings('admin:connections')}>
							Open Connections
						</Button>
					)}
					{hint === 'local' && (
						<Button asChild variant="ghost" size="sm">
							<Link to={routePaths.benchmarksServe}>Open Serve</Link>
						</Button>
					)}
				</div>
			</div>
		</div>
	);
}
