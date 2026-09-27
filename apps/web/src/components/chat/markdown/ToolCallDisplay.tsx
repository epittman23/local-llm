import { ChevronDown, ChevronUp, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { unescapeHtml } from '@/lib/markdown/content';
import { cn } from '@/lib/utils';

const RESULT_PREVIEW = 2000;

function pretty(text: string) {
	try {
		return JSON.stringify(JSON.parse(text), null, 2);
	} catch {
		return text;
	}
}

/**
 * Ports common/ToolCallDisplay.svelte: one tool call from a response's
 * `<details type="tool_calls">` block: its state (preparing, waiting for
 * approval, executing, done, denied, failed), arguments and result, and
 * Allow/Deny when the server is waiting for approval. The ask_user tool's
 * questions are answered in the chat itself (Phase 10's AskUser card).
 */
export function ToolCallDisplay({
	attributes,
	resultContent,
	messageDone,
	resolvable,
	resolving,
	onResolve,
	defaultOpen = false
}: {
	attributes: Record<string, string>;
	resultContent: string;
	messageDone: boolean;
	resolvable: boolean;
	resolving: boolean;
	onResolve: (approved: boolean) => void;
	defaultOpen?: boolean;
}) {
	const [open, setOpen] = useState(defaultOpen);
	const [showAll, setShowAll] = useState(false);
	const name = attributes.name ?? 'tool';
	const status = attributes.status;
	const result = resultContent || unescapeHtml(attributes.result ?? '');
	const args = pretty(unescapeHtml(attributes.arguments ?? ''));
	const askUser = name === 'ask_user';
	const needsApproval = !askUser && status === 'pending' && resolvable;
	const rejected = status === 'rejected';
	const done = attributes.done === 'true' || status === 'failed' || status === 'incomplete' || (messageDone && status !== 'pending');
	const executing = !done && !rejected && status === 'completed';
	const failed = status === 'failed';

	const label = rejected
		? `Denied ${name}`
		: done
			? `View Result from ${name}`
			: askUser && status === 'pending'
				? 'Input needed'
				: needsApproval
					? `Allow ${name}?`
					: executing
						? `Executing ${name}...`
						: `Preparing ${name}...`;

	return (
		<div className="my-1 w-full text-sm" data-testid="tool-call">
			<button type="button" className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 py-0.5" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
				{!done && !rejected && !needsApproval && <Loader2 className="size-3.5 animate-spin" />}
				<span className={cn(failed && 'text-destructive')}>{label}</span>
				{open ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
			</button>
			{needsApproval && (
				<div className="my-1 flex gap-2">
					<Button size="sm" disabled={resolving} onClick={() => onResolve(true)}>
						Allow
					</Button>
					<Button size="sm" variant="outline" disabled={resolving} onClick={() => onResolve(false)}>
						Deny
					</Button>
				</div>
			)}
			{open && (
				<div className="bg-muted/40 mt-1 flex flex-col gap-2 rounded-xl p-3">
					{args && (
						<div>
							<div className="text-muted-foreground mb-1 text-xs">Input</div>
							<pre className="overflow-x-auto text-xs whitespace-pre-wrap">{args}</pre>
						</div>
					)}
					{result && (
						<div>
							<div className="text-muted-foreground mb-1 text-xs">Output</div>
							<pre className="overflow-x-auto text-xs whitespace-pre-wrap">{showAll ? pretty(result) : pretty(result).slice(0, RESULT_PREVIEW)}</pre>
							{!showAll && pretty(result).length > RESULT_PREVIEW && (
								<button type="button" className="text-muted-foreground mt-1 text-xs underline" onClick={() => setShowAll(true)}>
									Show all ({pretty(result).length} characters)
								</button>
							)}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
