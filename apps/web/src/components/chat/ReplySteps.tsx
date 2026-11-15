import {
	Brain,
	ChevronDown,
	ChevronUp,
	CircleAlert,
	CircleHelp,
	Code,
	FileText,
	Globe,
	Loader2,
	type LucideIcon,
	SquareTerminal,
	Wrench
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Markdown } from '@/components/chat/markdown/Markdown';
import type { MarkdownEnv } from '@/components/chat/markdown/MarkdownContext';
import { Button } from '@/components/ui/button';
import { resolveChatMessageToolCall } from '@/lib/apis/chats';
import { fence, replySegments, type Step, type StepKind, type StepResult } from '@/lib/chat/replySteps';
import type { OutputItem } from '@/lib/chat/structuredOutput';
import { useUserSettings } from '@/lib/settings/userSettings';
import { useAuthStore } from '@/lib/stores/authStore';
import { cn } from '@/lib/utils';

/** How much of a long result shows before "Show all". */
const PREVIEW = 6000;

const ICONS: Record<StepKind, LucideIcon> = {
	reasoning: Brain,
	command: SquareTerminal,
	file: FileText,
	search: Globe,
	question: CircleHelp,
	code: Code,
	tool: Wrench
};

type Props = {
	id: string;
	output: OutputItem[];
	done: boolean;
	/** Markdown off (the "Markdown in assistant messages" setting): texts show as plain text. */
	plain?: boolean;
	/** Applied to each text the model wrote (citation stripping). */
	formatText?: (text: string) => string;
	modelName?: string;
	chatId?: string;
	messageId?: string;
	resolvable?: boolean;
	sourceIds?: string[];
	onSourceClick?: MarkdownEnv['onSourceClick'];
	onToolCallResolved?: () => void;
	onPreview?: MarkdownEnv['onPreview'];
	onRun?: MarkdownEnv['onRun'];
};

/**
 * A reply as it happened (StructuredOutputRenderer.svelte): the texts the
 * model wrote, and between them every step it took, one line each, in order.
 * A step opens to show its reasoning, what the tool was given and what came
 * back. While the reply is written the running step says so, so the work can
 * be followed as it goes.
 */
export function ReplySteps({
	id,
	output,
	done,
	plain = false,
	formatText = (t) => t,
	modelName,
	chatId,
	messageId,
	resolvable = false,
	sourceIds,
	onSourceClick,
	onToolCallResolved,
	onPreview,
	onRun
}: Props) {
	const segments = useMemo(() => replySegments(output, done), [output, done]);
	return (
		<div className="flex flex-col gap-1" data-testid="reply-steps">
			{segments.map((segment) =>
				segment.type === 'text' ? (
					plain ? (
						<div key={segment.id} className="text-reading whitespace-pre-wrap" dir="auto">
							{formatText(segment.text)}
						</div>
					) : (
						<Markdown
							key={segment.id}
							id={`${id}-${segment.id}`}
							content={formatText(segment.text)}
							done={done}
							modelName={modelName}
							chatId={chatId}
							messageId={messageId}
							sourceIds={sourceIds}
							onSourceClick={onSourceClick}
							onPreview={onPreview}
							onRun={onRun}
						/>
					)
				) : (
					<ol key={segment.id} className="border-border my-1 flex flex-col border-l pl-2" aria-label="Steps">
						{segment.steps.map((step) => (
							<StepRow
								key={step.id || step.title}
								step={step}
								chatId={chatId}
								messageId={messageId}
								resolvable={resolvable}
								onToolCallResolved={onToolCallResolved}
							/>
						))}
					</ol>
				)
			)}
		</div>
	);
}

function StepIndicator({ step }: { step: Step }) {
	if (step.status === 'running')
		return <Loader2 className="text-muted-foreground size-4 shrink-0 animate-spin" aria-hidden />;
	const Icon = ICONS[step.kind];
	return <Icon className="text-muted-foreground size-4 shrink-0" aria-hidden />;
}

/** The step's state as a word (COL-3): only where it is not plainly done. */
function StatusWord({ step }: { step: Step }) {
	switch (step.status) {
		case 'running':
			return <span className="sr-only">Running</span>;
		case 'failed':
			return (
				<span className="text-danger flex shrink-0 items-center gap-1 text-xs">
					<CircleAlert className="size-3.5" aria-hidden />
					Failed
				</span>
			);
		case 'waiting':
			return (
				<span className="text-warning shrink-0 text-xs">
					{step.kind === 'question' ? 'Waiting for your answer' : 'Waiting for approval'}
				</span>
			);
		case 'denied':
			return <span className="text-muted-foreground shrink-0 text-xs">Denied</span>;
		case 'unanswered':
			return (
				<span className="text-muted-foreground shrink-0 text-xs">
					{step.kind === 'question' ? 'No answer' : 'No result'}
				</span>
			);
		default:
			return null;
	}
}

function StepRow({
	step,
	chatId,
	messageId,
	resolvable,
	onToolCallResolved
}: {
	step: Step;
	chatId?: string;
	messageId?: string;
	resolvable: boolean;
	onToolCallResolved?: () => void;
}) {
	const { settings } = useUserSettings();
	const token = useAuthStore((s) => s.token) ?? '';
	const [open, setOpen] = useState(Boolean((settings as Record<string, unknown> | undefined)?.expandDetails));
	const [resolving, setResolving] = useState(false);
	const hasDetail = Boolean(step.reasoning || step.input || step.result.type !== 'none' || step.images.length);
	// ask_user is answered in its own dialog; other waiting calls are approved here.
	const approvable =
		step.status === 'waiting' && step.kind !== 'question' && resolvable && chatId && messageId && step.callId;

	const resolve = async (approved: boolean) => {
		if (!approvable || resolving) return;
		setResolving(true);
		try {
			await resolveChatMessageToolCall(
				token,
				chatId,
				messageId,
				step.callId as string,
				approved ? 'approve' : 'reject'
			);
			onToolCallResolved?.();
		} catch (e) {
			toast.error(String(e));
		}
		setResolving(false);
	};

	return (
		<li className="flex flex-col" data-testid="reply-step" data-status={step.status}>
			<Button
				type="button"
				variant="ghost"
				size="sm"
				className="text-muted-foreground w-full justify-start gap-2 px-1.5 text-left font-normal"
				aria-expanded={hasDetail ? open : undefined}
				disabled={!hasDetail}
				onClick={() => setOpen((o) => !o)}
			>
				<StepIndicator step={step} />
				<span className={cn('min-w-0 flex-1 truncate', step.kind === 'command' && 'font-mono text-xs')}>
					{step.title}
				</span>
				{step.meta && <span className="shrink-0 text-xs tabular-nums">{step.meta}</span>}
				<StatusWord step={step} />
				{hasDetail && (open ? <ChevronUp className="size-3 shrink-0" /> : <ChevronDown className="size-3 shrink-0" />)}
			</Button>
			{approvable && (
				<div className="my-1 ml-7 flex gap-2">
					<Button size="sm" disabled={resolving} onClick={() => void resolve(true)}>
						Allow
					</Button>
					<Button size="sm" variant="outline" disabled={resolving} onClick={() => void resolve(false)}>
						Deny
					</Button>
				</div>
			)}
			{open && hasDetail && (
				<div className="mt-1 mb-2 ml-7 flex min-w-0 flex-col gap-2 text-sm">
					{step.reasoning && (
						<Markdown id={`step-${step.id}-reasoning`} content={step.reasoning} className="text-muted-foreground" />
					)}
					{step.input && <Markdown id={`step-${step.id}-input`} content={step.input} />}
					<StepResultView step={step} />
					{step.images.map((src, i) => (
						<img
							key={src}
							src={src}
							alt={step.images.length > 1 ? `What ${step.title} returned (${i + 1})` : `What ${step.title} returned`}
							className="border-border bg-canvas max-w-full rounded border"
						/>
					))}
				</div>
			)}
		</li>
	);
}

function LongText({ id, text, language, label }: { id: string; text: string; language: string; label?: string }) {
	const [all, setAll] = useState(false);
	const shown = all || text.length <= PREVIEW ? text : text.slice(0, PREVIEW);
	return (
		<div className="flex min-w-0 flex-col gap-1">
			{label && <div className="text-muted-foreground text-xs">{label}</div>}
			<Markdown id={id} content={fence(shown, language)} />
			{shown !== text && (
				<Button type="button" variant="link" size="xs" className="self-start" onClick={() => setAll(true)}>
					Show all ({text.length.toLocaleString()} characters)
				</Button>
			)}
		</div>
	);
}

function StepResultView({ step }: { step: Step }) {
	const result: StepResult = step.result;
	switch (result.type) {
		case 'command':
			return (
				<div className="flex flex-col gap-1">
					<div className="text-muted-foreground text-xs">
						{result.exitCode === null ? 'Finished' : `Exit code ${result.exitCode}`}
						{result.timedOut && ' · stopped at its time limit'}
						{result.truncated && ' · output cut short'}
					</div>
					{result.stdout && (
						<LongText id={`step-${step.id}-stdout`} text={result.stdout} language="text" label="Output" />
					)}
					{result.stderr && (
						<LongText id={`step-${step.id}-stderr`} text={result.stderr} language="text" label="Errors" />
					)}
				</div>
			);
		case 'error':
			return <p className="text-danger text-sm">{result.message}</p>;
		case 'text':
			return <LongText id={`step-${step.id}-result`} text={result.text} language={result.language} label="Result" />;
		default:
			return null;
	}
}
