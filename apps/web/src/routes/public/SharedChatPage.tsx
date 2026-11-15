import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { Markdown } from '@/components/chat/markdown/Markdown';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { Gone, isNotFound } from '@/components/common/Gone';
import { LoadFailed } from '@/components/common/LoadFailed';
import { BootSplash } from '@/components/layout/BootSplash';
import { AppMark } from '@/components/ui/app-mark';
import { Button } from '@/components/ui/button';
import { cloneSharedChatById, deleteSharedChatById, getChatByShareId } from '@/lib/apis/chats';
import { APP_NAME } from '@/lib/constants';
import { useAuthStore } from '@/lib/stores/authStore';
import { useDocumentTitle } from '@/lib/stores/configStore';
import { convertMessagesToHistory, createMessagesList } from '@/lib/utils/auth-helpers';
import { dayjs, shownTime } from '@/lib/utils/dates';
import { routePaths } from '@/routes/routePaths';

/** The server's detail for a share this signed-in user may not read (`ERROR_MESSAGES.ACCESS_PROHIBITED`). */
const ACCESS_PROHIBITED_DETAIL =
	'You do not have permission to access this resource. Please contact your administrator for assistance.';

/**
 * Ports d863707:apps/openwebui/src/routes/s/[id]/+page.svelte as the "read-only
 * React island" Phase 6's own checklist calls for (docs/history/migration-plan.md)
 * -- not a port of chat/Messages.svelte. Each message goes through the chat's
 * Markdown renderer, as the Svelte page's did: the sharer wrote this content
 * and anyone with the link sees it on this origin, so raw HTML must show as
 * text, never as live markup (docs/history/code-review.md H1).
 *
 * The server says when a share does not exist (404, #953), so anyone, signed
 * in or not, is told the link no longer works; only a share that exists but
 * is not open sends an anonymous visitor to sign in. To the owner of the
 * shared chat (the server gives only them `original_chat_id`, #1005) the
 * page offers Open original and Stop sharing, which asks first (ACT-3).
 */
export function SharedChatPage() {
	const { id } = useParams();
	const navigate = useNavigate();
	const token = useAuthStore((state) => state.token) ?? '';
	const user = useAuthStore((state) => state.user);
	const authStatus = useAuthStore((state) => state.status);

	const chatQuery = useQuery({
		queryKey: ['shared-chat', id, token],
		queryFn: () => getChatByShareId(token, id as string),
		// Wait for the session: a share limited to signed-in users answers an
		// anonymous request with 401, and asking before the token is restored
		// sent a signed-in visitor home.
		enabled: !!id && authStatus !== 'pending',
		retry: false
	});

	// The API helpers throw the server's detail string, whatever the query's Error type says.
	const missing = chatQuery.isError && isNotFound(chatQuery.error as unknown);
	useEffect(() => {
		// Anonymous and a share that exists but is not open: sign in, then come
		// back. A missing share is said in place instead, as to anyone (#953).
		if (chatQuery.isError && !missing && authStatus === 'anonymous')
			navigate(`${routePaths.auth}?redirect=${encodeURIComponent(`/s/${id}`)}`, { replace: true });
	}, [chatQuery.isError, missing, authStatus, id, navigate]);

	// The shared chat's owner may open it or stop sharing it; nobody else is told which chat it is.
	const originalId = (chatQuery.data as { original_chat_id?: string | null } | undefined)?.original_chat_id ?? null;
	const [confirmStop, setConfirmStop] = useState(false);
	const [stopped, setStopped] = useState(false);
	const stopSharing = async () => {
		if (!originalId) return;
		const ok = await deleteSharedChatById(token, originalId).then(
			() => true,
			(e) => void toast.error(`${e}`)
		);
		if (ok) setStopped(true);
	};

	const chatContent = chatQuery.data?.chat;

	const messages = useMemo(() => {
		if (!chatContent) return [];
		const history = chatContent.history ?? convertMessagesToHistory(chatContent.messages ?? []);
		return createMessagesList(history, history.currentId);
	}, [chatContent]);

	// The tab names the chat through the shared title mechanism (LAY-5), or says
	// the link is gone, as the page does (NAV-3).
	const title = chatContent?.title;
	const linkGone = missing || stopped;
	useDocumentTitle(
		linkGone ? 'Shared link not available' : title ? (title.length > 30 ? `${title.slice(0, 30)}...` : title) : null
	);

	const canClone = !!user && (user.role === 'admin' || (user.permissions as any)?.chat?.import !== false);

	const [cloning, setCloning] = useState(false);
	const cloneChat = async () => {
		if (!canClone || !chatQuery.data) return;
		setCloning(true);
		try {
			const res = await cloneSharedChatById(token, chatQuery.data.id);
			if (res) {
				// /c/:id is Phase 10's chat surface, not a React route yet: a full
				// navigation to the page the Svelte app still owns.
				window.location.assign(`/c/${res.id}`);
			}
		} catch (err) {
			// A refusal (say, a share holding an unfinished response) must show.
			toast.error(`${err}`);
		}
		setCloning(false);
	};

	// STA-2: the boot splash's look while the share loads, never a bare "Loading…".
	if (chatQuery.isLoading || authStatus === 'pending') return <BootSplash />;

	if (stopped)
		return (
			<main className="bg-page flex min-h-svh w-full flex-col justify-center">
				<Gone
					title="This shared link is no longer available."
					description="You stopped sharing this chat. The chat itself is still in your chats."
					actions={
						<>
							{originalId && (
								<Button variant="outline" asChild>
									<Link to={`/c/${originalId}`}>Open original</Link>
								</Button>
							)}
							<Button asChild>
								<Link to={routePaths.home}>Go to your chats</Link>
							</Button>
						</>
					}
				/>
			</main>
		);

	if (chatQuery.isError && (missing || authStatus !== 'anonymous')) {
		// NAV-3: a revoked or mistyped link says so, on a page of its own rather
		// than a bounce to a new chat. Any other failure can be tried again.
		const detail: unknown = chatQuery.error;
		return (
			<main className="bg-page flex min-h-svh w-full flex-col justify-center">
				{missing || detail === ACCESS_PROHIBITED_DETAIL ? (
					<Gone
						title={missing ? 'This shared link is no longer available.' : 'This shared chat is not open to you.'}
						description={
							missing
								? 'Whoever shared it may have stopped sharing it, or the link may be mistyped.'
								: 'Sign in with the account that shared it, or ask for a link anyone can open.'
						}
						actions={
							authStatus === 'anonymous' ? (
								<Button asChild>
									<Link to={routePaths.auth}>Sign in</Link>
								</Button>
							) : (
								<Button asChild>
									<Link to={routePaths.home}>Go to your chats</Link>
								</Button>
							)
						}
					/>
				) : (
					<LoadFailed
						what="this shared chat"
						error={chatQuery.error}
						onRetry={() => void chatQuery.refetch()}
						retrying={chatQuery.isFetching}
					/>
				)}
			</main>
		);
	}

	if (!chatContent) return null;

	// When the snapshot was taken: the share's own date, else the chat's (DAT-5, a record).
	const capturedSeconds = chatQuery.data?.updated_at ?? (chatContent.timestamp ? chatContent.timestamp / 1000 : null);
	const captured = capturedSeconds
		? { ...shownTime(capturedSeconds), label: dayjs.unix(capturedSeconds).format('YYYY-MM-DD') }
		: null;

	return (
		<div className="bg-page flex h-svh w-full flex-col">
			{/* #1005: what this page is, whose app it is in, and when it was captured (LAY-5, WRD-3). */}
			<header className="border-border-divider flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2">
				<Link to={routePaths.home} className="text-body font-title inline-flex items-center gap-2">
					<AppMark size={24} />
					{APP_NAME}
				</Link>
				<p className="text-dense text-foreground-muted min-w-0">
					Shared conversation
					{captured && (
						<>
							{' · captured '}
							<time dateTime={captured.iso} title={captured.exact}>
								{captured.label}
							</time>
						</>
					)}
				</p>
				<div className="ms-auto flex flex-wrap items-center gap-2">
					{originalId && (
						<>
							<Button variant="outline" className="text-danger" onClick={() => setConfirmStop(true)}>
								Stop sharing
							</Button>
							<Button variant="outline" asChild>
								<Link to={`/c/${originalId}`}>Open original</Link>
							</Button>
						</>
					)}
					{canClone && (
						<Button onClick={cloneChat} disabled={cloning} aria-busy={cloning || undefined}>
							{cloning ? 'Copying to your chats…' : 'Continue this chat'}
						</Button>
					)}
				</div>
			</header>
			<ConfirmDialog
				open={confirmStop}
				onOpenChange={setConfirmStop}
				title={`Stop sharing “${chatContent.title ?? 'this chat'}”?`}
				confirmLabel="Stop sharing"
				onConfirm={stopSharing}
			>
				The link stops working for everyone who has it. The chat itself stays in your chats.
			</ConfirmDialog>
			<main className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto w-full max-w-3xl px-4 py-6">
					<h1 className="text-heading font-title line-clamp-2 tracking-tight" title={chatContent.title}>
						{chatContent.title}
					</h1>

					<div className="mt-6 flex flex-col gap-6">
						{messages.map((message: any) => (
							<section
								key={message.id}
								aria-label={message.role === 'user' ? 'User' : 'Assistant'}
								className="flex flex-col gap-1"
							>
								<p className="text-caption font-strong text-foreground-muted">
									{message.role === 'user' ? 'User' : (message.model ?? 'Assistant')}
								</p>
								<Markdown id={`shared-${message.id}`} content={message.content ?? ''} modelName={message.model} />
							</section>
						))}
					</div>
				</div>
			</main>
		</div>
	);
}
