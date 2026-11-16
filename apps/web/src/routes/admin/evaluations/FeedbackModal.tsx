import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { getFeedbackById } from '@/lib/apis/evaluations';
import { useAuthStore } from '@/lib/stores/authStore';
import { dayjs } from '@/lib/utils/dates';
import { appHref } from '@/routes/routePaths';
import { useSingleUser } from '@/routes/workspace/workspaceAccess';
import { feedbackResult, ResultBadge } from './feedbackResult';

type Message = { content?: string; parentId?: string | null };
export type FeedbackItem = {
	id: string;
	user?: { id: string; name?: string };
	meta?: { chat_id?: string; message_id?: string };
	data?: {
		model_id?: string;
		sibling_model_ids?: string[];
		rating?: unknown;
		reason?: string;
		comment?: string;
		tags?: string[];
		details?: { rating?: unknown };
	} | null;
	updated_at: number;
};

function Field({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="flex flex-col gap-0.5">
			<dt className="text-foreground-muted text-dense">{label}</dt>
			<dd className="break-words">{children}</dd>
		</div>
	);
}

/** A missing value is an en dash, never blank (DAT-2). */
const orDash = (text?: string | null) => text || <span className="text-foreground-muted">–</span>;

/**
 * Ports Evaluations/FeedbackModal.svelte: one rating's model, result and date,
 * the prompt and response it was about (read from the chat snapshot), its
 * reason, comment and tags, and a link to the chat. The Svelte version throws
 * when a feedback has no snapshot; here the prompt and response are omitted.
 */
export function FeedbackModal({
	open,
	onOpenChange,
	feedback
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	feedback: FeedbackItem | null;
}) {
	const token = useAuthStore((s) => s.token) ?? '';
	const singleUser = useSingleUser();
	const detail = useQuery({
		queryKey: ['admin', 'feedback', feedback?.id],
		queryFn: () => getFeedbackById(token, feedback?.id ?? '').catch(() => null),
		enabled: open && !!feedback?.id
	});

	if (!feedback) return null;
	const data = detail.data as
		| {
				meta?: { message_id?: string };
				snapshot?: { chat?: { chat?: { history?: { messages?: Record<string, Message> } } } };
		  }
		| null
		| undefined;
	const messages = data?.snapshot?.chat?.chat?.history?.messages ?? {};
	const response = messages[data?.meta?.message_id ?? ''];
	const prompt = response?.parentId ? messages[response.parentId] : undefined;
	const chatId = feedback.meta?.chat_id;
	const siblings = feedback.data?.sibling_model_ids ?? [];
	const when = dayjs(feedback.updated_at * 1000);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Rating details</DialogTitle>
					<DialogDescription className="sr-only">
						The model, result and chat behind one rating, with its reason and comment.
					</DialogDescription>
				</DialogHeader>
				<dl className="flex w-full flex-col gap-3">
					<div className="grid grid-cols-2 gap-3">
						<Field label="Model">
							<span className="font-mono break-all">{orDash(feedback.data?.model_id)}</span>
						</Field>
						<Field label="Result">
							<ResultBadge result={feedbackResult(feedback)} />
						</Field>
						{siblings.length > 0 && (
							<Field label="Compared with">
								<span className="font-mono break-all">{siblings.join(', ')}</span>
							</Field>
						)}
						<Field label="Rated">
							<time dateTime={when.toISOString()}>{when.format('YYYY-MM-DD HH:mm')}</time>
						</Field>
						{/* S4-D1: who rated says nothing while the install has one account. */}
						{!singleUser && feedback.user?.name && <Field label="By">{feedback.user.name}</Field>}
					</div>
					{detail.isPending ? (
						<div aria-busy="true" className="bg-surface-3 h-20 animate-pulse rounded">
							<span className="sr-only" role="status">
								Loading the chat
							</span>
						</div>
					) : (
						<>
							{prompt && (
								<Field label="Prompt">
									<span className="whitespace-pre-line">{orDash(prompt.content)}</span>
								</Field>
							)}
							{response && (
								<Field label="Response">
									<div className="max-h-40 overflow-y-auto whitespace-pre-line">{orDash(response.content)}</div>
								</Field>
							)}
						</>
					)}
					<Field label="Reason">{orDash(feedback.data?.reason)}</Field>
					<Field label="Comment">{orDash(feedback.data?.comment)}</Field>
					{feedback.data?.tags && feedback.data.tags.length > 0 && (
						<Field label="Tags">
							<span className="flex flex-wrap gap-1">
								{feedback.data.tags.map((tag) => (
									<span key={tag} className="bg-muted text-caption rounded-full px-2 py-0.5">
										{tag}
									</span>
								))}
							</span>
						</Field>
					)}
				</dl>
				<div className="flex flex-wrap justify-end gap-2">
					{chatId && (
						<Button asChild variant="outline">
							<a href={appHref(`/s/${chatId}`)} target="_blank" rel="noreferrer">
								Open chat
								<ExternalLink data-icon="inline-end" aria-hidden />
								<span className="sr-only"> (opens in a new tab)</span>
							</a>
						</Button>
					)}
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						Close
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
