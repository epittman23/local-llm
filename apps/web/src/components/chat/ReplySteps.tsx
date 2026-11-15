import {
	Brain,
	ChevronDown,
	ChevronUp,
	CircleAlert,
	CircleHelp,
	Code,
	FileText,
	Globe,
	type LucideIcon,
	SquareTerminal,
	Wrench
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { type OrbState, ThinkingOrb } from 'thinking-orbs';
import { Markdown } from '@/components/chat/markdown/Markdown';
import type { MarkdownEnv } from '@/components/chat/markdown/MarkdownContext';
import { Button } from '@/components/ui/button';
import { resolveChatMessageToolCall } from '@/lib/apis/chats';
import {
	currentStep,
	fence,
	type ReplyActivity,
	replyActivity,
	replySegments,
	type Step,
	type StepKind,
	type StepResult
} from '@/lib/chat/replySteps';
import type { OutputItem } from '@/lib/chat/structuredOutput';
import { removeAllDetails } from '@/lib/markdown/content';
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
 * back. Two or more steps in a row are one chain, collapsed to the step it is
 * at, so a long run reads as the texts with one line between them. While the
 * reply is written its spinner (ReplyOrb) sits below it.
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
							{removeAllDetails(formatText(segment.text))}
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
						{segment.steps.length > 1 ? (
							<StepChain
								steps={segment.steps}
								chatId={chatId}
								messageId={messageId}
								resolvable={resolvable}
								onToolCallResolved={onToolCallResolved}
							/>
						) : (
							<StepRow
								step={segment.steps[0]}
								chatId={chatId}
								messageId={messageId}
								resolvable={resolvable}
								onToolCallResolved={onToolCallResolved}
							/>
						)}
					</ol>
				)
			)}
		</div>
	);
}

/** The spinner's animation and words, by what the reply is doing. */
const ACTIVITY: Record<ReplyActivity, { orb: OrbState; label: string }> = {
	starting: { orb: 'breathing', label: 'Waiting for the reply' },
	between: { orb: 'breathing', label: 'Working' },
	writing: { orb: 'composing', label: 'Writing' },
	reasoning: { orb: 'solving', label: 'Thinking' },
	command: { orb: 'working', label: 'Running a command' },
	file: { orb: 'shaping', label: 'Working on a file' },
	search: { orb: 'searching', label: 'Searching' },
	question: { orb: 'listening', label: 'Asking you' },
	code: { orb: 'working', label: 'Running code' },
	tool: { orb: 'connecting', label: 'Using a tool' }
};

/**
 * The reply's spinner: one thinking orb below everything the reply has shown
 * so far, so it stays at the bottom of the chat as the reply grows, animated
 * by what the reply is doing. Nothing while the reply waits on the person.
 */
export function ReplyOrb({ output }: { output?: OutputItem[] }) {
	const activity = useMemo(() => replyActivity(output), [output]);
	if (!activity) return null;
	const { orb, label } = ACTIVITY[activity];
	return (
		<div className="py-2" data-testid="reply-orb" data-activity={activity}>
			<ThinkingOrb state={orb} size={20} aria-label={label} />
		</div>
	);
}

function StepIndicator({ step }: { step: Step }) {
	const Icon = ICONS[step.kind];
	return <Icon className="text-foreground-muted size-4 shrink-0" aria-hidden />;
}

/** The step's state as a word (COL-3): only where it is not plainly done. */
function StatusWord({ step }: { step: Step }) {
	switch (step.status) {
		case 'running':
			return <span className="text-foreground-muted shrink-0 text-caption">Running</span>;
		case 'queued':
			return <span className="text-foreground-muted shrink-0 text-caption">Queued</span>;
		case 'failed':
			return (
				<span className="text-danger flex shrink-0 items-center gap-1 text-caption">
					<CircleAlert className="size-3.5" aria-hidden />
					Failed
				</span>
			);
		case 'waiting':
			return (
				<span className="text-warning shrink-0 text-caption">
					{step.kind === 'question' ? 'Waiting for your answer' : 'Waiting for approval'}
				</span>
			);
		case 'denied':
			return <span className="text-foreground-muted shrink-0 text-caption">Denied</span>;
		case 'unanswered':
			return (
				<span className="text-foreground-muted shrink-0 text-caption">
					{step.kind === 'question' ? 'No answer' : 'No result'}
				</span>
			);
		default:
			return null;
	}
}

/**
 * Two or more steps in a row, between two texts: one line naming the step the
 * chain is at (the running one, else one waiting on the person, else the
 * last), opening to every step. A chain with a call to approve stays open, so
 * Allow and Deny are never hidden.
 */
function StepChain({
	steps,
	chatId,
	messageId,
	resolvable,
	onToolCallResolved
}: {
	steps: Step[];
	chatId?: string;
	messageId?: string;
	resolvable: boolean;
	onToolCallResolved?: () => void;
}) {
	const { settings } = useUserSettings();
	const [open, setOpen] = useState(Boolean((settings as Record<string, unknown> | undefined)?.expandDetails));
	const current = currentStep(steps);
	const mustOpen = resolvable && steps.some((s) => s.approvable);
	const shown = open || mustOpen;
	const failed = steps.filter((s) => s.status === 'failed').length;
	return (
		<li className="flex flex-col" data-testid="step-chain">
			<Button
				type="button"
				variant="ghost"
				size="sm"
				className="text-foreground-muted w-full justify-start gap-2 px-1.5 text-left font-normal"
				aria-expanded={shown}
				onClick={() => setOpen((o) => !o)}
			>
				<StepIndicator step={current} />
				<span className={cn('min-w-0 flex-1 truncate', current.kind === 'command' && 'font-mono text-dense')}>
					{current.title}
				</span>
				{current.meta && <span className="shrink-0 text-caption tabular-nums">{current.meta}</span>}
				<StatusWord step={current} />
				{failed > 0 && current.status !== 'failed' && (
					<span className="text-danger flex shrink-0 items-center gap-1 text-caption">
						<CircleAlert className="size-3.5" aria-hidden />
						{failed} failed
					</span>
				)}
				<span className="shrink-0 text-caption tabular-nums">{steps.length} steps</span>
				{shown ? <ChevronUp className="size-3 shrink-0" /> : <ChevronDown className="size-3 shrink-0" />}
			</Button>
			{shown && (
				<ol className="border-border mt-1 ml-3 flex flex-col border-l pl-2" aria-label={`${steps.length} steps`}>
					{steps.map((step) => (
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
			)}
		</li>
	);
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
	const hasDetail = Boolean(step.reasoning || step.input || step.result.type !== 'none' || step.images.length);
	// The one call a paused round waits on is approved here. A question is answered
	// in its own dialog, from the stored reply (#1127).
	const approvable = step.approvable && resolvable && chatId && messageId && step.callId;
	const object = step.kind === 'command' ? 'command' : 'tool call';
	const [resolving, setResolving] = useState<'allow' | 'deny' | null>(null);

	const resolve = async (approved: boolean) => {
		if (!approvable || resolving) return;
		setResolving(approved ? 'allow' : 'deny');
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
			toast.error(`The ${object} could not be ${approved ? 'allowed' : 'denied'}: ${String(e)}`);
		}
		setResolving(null);
	};

	const summary = (
		<>
			<StepIndicator step={step} />
			<span className={cn('min-w-0 flex-1 truncate', step.kind === 'command' && 'font-mono text-dense')}>
				{step.title}
			</span>
			{step.meta && <span className="shrink-0 text-caption tabular-nums">{step.meta}</span>}
			<StatusWord step={step} />
		</>
	);

	return (
		<li className="flex flex-col" data-testid="reply-step" data-status={step.status}>
			{hasDetail ? (
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="text-foreground-muted w-full justify-start gap-2 px-1.5 text-left font-normal"
					aria-expanded={open}
					onClick={() => setOpen((o) => !o)}
				>
					{summary}
					{open ? <ChevronUp className="size-3 shrink-0" /> : <ChevronDown className="size-3 shrink-0" />}
				</Button>
			) : (
				// Nothing to open: a line of text, not a disabled control (which would dim it).
				<div className="text-foreground-muted flex h-7 w-full items-center gap-2 px-1.5 text-dense">{summary}</div>
			)}
			{approvable && (
				<div className="my-1 ml-6 flex gap-2" aria-busy={resolving !== null}>
					<Button size="sm" disabled={resolving !== null} onClick={() => void resolve(true)}>
						{resolving === 'allow' ? 'Allowing…' : `Allow ${object}`}
					</Button>
					<Button size="sm" variant="outline" disabled={resolving !== null} onClick={() => void resolve(false)}>
						{resolving === 'deny' ? 'Denying…' : `Deny ${object}`}
					</Button>
				</div>
			)}
			{open && hasDetail && (
				<div className="mt-1 mb-2 ml-6 flex min-w-0 flex-col gap-2 text-body">
					{step.reasoning && (
						<Markdown id={`step-${step.id}-reasoning`} content={step.reasoning} className="text-foreground-muted" />
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
			{label && <div className="text-foreground-muted text-caption">{label}</div>}
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
					<div className="text-foreground-muted text-caption">
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
			return <p className="text-danger text-body">{result.message}</p>;
		case 'text':
			return <LongText id={`step-${step.id}-result`} text={result.text} language={result.language} label="Result" />;
		default:
			return null;
	}
}
