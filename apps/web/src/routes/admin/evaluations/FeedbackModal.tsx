import { useQuery } from '@tanstack/react-query';
import { Spinner } from '@/components/common/Spinner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { getFeedbackById } from '@/lib/apis/evaluations';
import { useAuthStore } from '@/lib/stores/authStore';
import { appHref } from '@/routes/routePaths';

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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="mb-2 flex w-full flex-col">
			<div className="text-muted-foreground mb-1 text-xs">{label}</div>
			{children}
		</div>
	);
}

/**
 * Ports Evaluations/FeedbackModal.svelte: one feedback's chat link, the prompt
 * and response it was about (read from the chat snapshot), rating, reason,
 * comment and tags. The Svelte version throws when a feedback has no snapshot;
 * here the prompt and response are simply omitted.
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
	const detail = useQuery({
		queryKey: ['admin', 'feedback', feedback?.id],
		queryFn: () => getFeedbackById(token, feedback!.id).catch(() => null),
		enabled: open && !!feedback?.id
	});

	if (!feedback) return null;
	const data = detail.data as { meta?: { message_id?: string }; snapshot?: { chat?: { chat?: { history?: { messages?: Record<string, Message> } } } } } | null | undefined;
	const messages = data?.snapshot?.chat?.chat?.history?.messages ?? {};
	const response = messages[data?.meta?.message_id ?? ''];
	const prompt = response?.parentId ? messages[response.parentId] : undefined;
	const chatId = feedback.meta?.chat_id;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle className="text-sm font-medium">Feedback Details</DialogTitle>
					<DialogDescription className="sr-only">The chat, rating and comments behind one feedback.</DialogDescription>
				</DialogHeader>
				{detail.isPending ? (
					<div className="flex h-32 w-full items-center justify-center">
						<Spinner />
					</div>
				) : (
					<div className="flex w-full flex-col">
						<Field label="Chat ID">
							<div className="flex-1 text-xs">
								{chatId ? (
									<a href={appHref(`/s/${chatId}`)} className="hover:underline" target="_blank" rel="noreferrer">
										{chatId}
									</a>
								) : (
									'-'
								)}
							</div>
						</Field>
						{prompt && (
							<Field label="Prompt">
								<div className="flex-1 text-xs break-words whitespace-pre-line">{prompt.content || '-'}</div>
							</Field>
						)}
						{response && (
							<Field label="Response">
								<div className="max-h-32 flex-1 overflow-y-auto text-xs break-words whitespace-pre-line">{response.content || '-'}</div>
							</Field>
						)}
						<Field label="Rating">
							<div className="flex-1 text-xs">{String(feedback.data?.details?.rating ?? '-')}</div>
						</Field>
						<Field label="Reason">
							<div className="flex-1 text-xs">{feedback.data?.reason || '-'}</div>
						</Field>
						<Field label="Comment">
							<div className="flex-1 text-xs">{feedback.data?.comment || '-'}</div>
						</Field>
						{feedback.data?.tags && feedback.data.tags.length > 0 && (
							<div className="-mx-1 mb-2 mt-1 flex flex-wrap gap-1">
								{feedback.data.tags.map((tag) => (
									<span key={tag} className="bg-muted rounded-full px-2 py-0.5 text-[0.5625rem]">
										{tag}
									</span>
								))}
							</div>
						)}
						<div className="flex justify-end pt-2">
							<Button size="sm" onClick={() => onOpenChange(false)}>
								Close
							</Button>
						</div>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
