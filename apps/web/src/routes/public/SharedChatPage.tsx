import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Markdown } from '@/components/chat/markdown/Markdown';
import { cloneSharedChatById, getChatByShareId } from '@/lib/apis/chats';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/lib/stores/authStore';
import { useWebUIName } from '@/lib/stores/configStore';
import { convertMessagesToHistory, createMessagesList } from '@/lib/utils/auth-helpers';
import { routePaths } from '@/routes/routePaths';

/**
 * Ports d863707:apps/openwebui/src/routes/s/[id]/+page.svelte as the "read-only
 * React island" Phase 6's own checklist calls for (docs/migration-plan.md)
 * -- not a port of chat/Messages.svelte. Each message goes through the chat's
 * Markdown renderer, as the Svelte page's did: the sharer wrote this content
 * and anyone with the link sees it on this origin, so raw HTML must show as
 * text, never as live markup (docs/code-review.md H1).
 */
export function SharedChatPage() {
	const { id } = useParams();
	const navigate = useNavigate();
	const token = useAuthStore((state) => state.token) ?? '';
	const user = useAuthStore((state) => state.user);
	const authStatus = useAuthStore((state) => state.status);
	const WEBUI_NAME = useWebUIName();

	const chatQuery = useQuery({
		queryKey: ['shared-chat', id, token],
		queryFn: () => getChatByShareId(token, id as string),
		// Wait for the session: a share limited to signed-in users answers an
		// anonymous request with 401, and asking before the token is restored
		// sent a signed-in visitor home.
		enabled: !!id && authStatus !== 'pending',
		retry: false
	});

	useEffect(() => {
		if (!chatQuery.isError) return;
		// Anonymous and not an open share: sign in, then come back.
		if (authStatus === 'anonymous')
			navigate(`${routePaths.auth}?redirect=${encodeURIComponent(`/s/${id}`)}`, { replace: true });
		else navigate(routePaths.home, { replace: true });
	}, [chatQuery.isError, authStatus, id, navigate]);

	const chatContent = chatQuery.data?.chat;

	const messages = useMemo(() => {
		if (!chatContent) return [];
		const history = chatContent.history ?? convertMessagesToHistory(chatContent.messages ?? []);
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
				// /c/:id is Phase 10's chat surface, not a React route yet: a full
				// navigation to the page the Svelte app still owns.
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
							<Markdown
								id={`shared-${message.id}`}
								content={message.content ?? ''}
								modelName={message.model}
								className="text-sm"
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
