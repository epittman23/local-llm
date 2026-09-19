import { useQuery } from '@tanstack/react-query';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useEffect, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router';
import { cloneSharedChatById, getChatByShareId } from '@/lib/apis/chats';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/lib/stores/authStore';
import { useWebUIName } from '@/lib/stores/configStore';
import { convertMessagesToHistory, createMessagesList } from '@/lib/utils/auth-helpers';
import { routePaths } from '@/routes/routePaths';

/**
 * Ports apps/openwebui/src/routes/s/[id]/+page.svelte as the "read-only
 * React island" Phase 6's own checklist calls for (docs/migration-plan.md)
 * -- not a port of chat/Messages.svelte (that's Phase 10's, ~46k LOC). Each
 * message's content is rendered through the same marked + DOMPurify
 * pipeline already established for Report/Tune (Phase 5) rather than
 * plain preformatted text (AnswersPage.tsx's own choice): real chat
 * content is prose people expect formatted, unlike graded benchmark code.
 */
export function SharedChatPage() {
	const { id } = useParams();
	const navigate = useNavigate();
	const token = useAuthStore((state) => state.token) ?? '';
	const user = useAuthStore((state) => state.user);
	const WEBUI_NAME = useWebUIName();

	const chatQuery = useQuery({
		queryKey: ['shared-chat', id],
		queryFn: () => getChatByShareId(token, id as string),
		enabled: !!id,
		retry: false
	});

	useEffect(() => {
		if (chatQuery.isError) {
			navigate(routePaths.home, { replace: true });
		}
	}, [chatQuery.isError, navigate]);

	const chatContent = chatQuery.data?.chat;

	const messages = useMemo(() => {
		if (!chatContent) return [];
		const history =
			chatContent.history ?? convertMessagesToHistory(chatContent.messages ?? []);
		return createMessagesList(history, history.currentId);
	}, [chatContent]);

	useEffect(() => {
		document.title = chatContent?.title
			? `${chatContent.title.length > 30 ? `${chatContent.title.slice(0, 30)}...` : chatContent.title} / ${WEBUI_NAME}`
			: WEBUI_NAME;
	}, [chatContent?.title, WEBUI_NAME]);

	const canClone = !!user && (user.role === 'admin' || (user.permissions as any)?.chat?.import !== false);

	const cloneChat = async () => {
		if (!canClone || !chatQuery.data) return;
		try {
			const res = await cloneSharedChatById(token, chatQuery.data.id);
			if (res) {
				// /c/:id is Phase 10's chat surface, not a React route yet -- a
				// full navigation to the still-SvelteKit-owned page, same
				// reasoning as LegacyFallback.tsx's own default case.
				window.location.assign(`/c/${res.id}`);
			}
		} catch (err) {
			console.error(err);
		}
	};

	if (chatQuery.isLoading) {
		return (
			<div className="flex h-screen w-full items-center justify-center">
				<p className="text-muted-foreground text-sm">Loading…</p>
			</div>
		);
	}

	if (!chatContent) return null;

	return (
		<div className="flex h-screen w-full flex-col overflow-y-auto">
			<div className="mx-auto w-full max-w-3xl px-3 pt-5 pb-24">
				<h1 className="line-clamp-1 text-2xl font-normal">{chatContent.title}</h1>
				<time className="text-muted-foreground text-sm">
					{new Date(chatContent.timestamp ?? Date.now()).toLocaleString()}
				</time>

				<div className="mt-6 flex flex-col gap-6">
					{messages.map((message: any) => (
						<div key={message.id} className="flex flex-col gap-1">
							<div className="text-muted-foreground text-xs font-medium">
								{message.role === 'user' ? 'You' : (message.model ?? 'Assistant')}
							</div>
							<div
								className="prose dark:prose-invert max-w-none text-sm"
								dangerouslySetInnerHTML={{
									__html: DOMPurify.sanitize(marked.parse(message.content ?? '') as string)
								}}
							/>
						</div>
					))}
				</div>
			</div>

			{canClone && (
				<div className="from-background fixed right-0 bottom-0 left-0 flex justify-center bg-gradient-to-t to-transparent pb-5">
					<Button onClick={cloneChat}>Clone Chat</Button>
				</div>
			)}
		</div>
	);
}
