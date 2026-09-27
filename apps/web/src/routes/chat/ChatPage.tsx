import { useQuery } from '@tanstack/react-query';
import { EyeOff } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { Spinner } from '@/components/common/Spinner';
import { Tip } from '@/components/common/Tip';
import { getFolderById } from '@/lib/apis/folders';
import { updateChatById } from '@/lib/apis/chats';
import type { History } from '@/lib/chat/history';
import { type Citation, citationIndex, citationsOf } from '@/lib/chat/sources';
import { initialModels } from '@/lib/chat/request';
import { useUserSettings } from '@/lib/settings/userSettings';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore, useDocumentTitle } from '@/lib/stores/configStore';
import { cn } from '@/lib/utils';
import { ChatInput, type ChatInputHandle } from './ChatInput';
import { ChatMessages, type MessageHandlers } from './ChatMessages';
import { ChatPlaceholder } from './ChatPlaceholder';
import { CitationDialog } from './CitationDialog';
import { useMessageActions } from './MessageActions';
import { ModelSelector } from './ModelSelector';
import { ServerDialogs } from './ServerDialogs';
import { useChatSession } from './useChatSession';
import { useModels } from './useModels';

type Folder = { id: string; name: string; data?: { model_ids?: string[] } | null };

/**
 * Ports routes/(app)/+page.svelte, c/[id] and folders/[folderId], which all
 * render chat/Chat.svelte. One layout route serves the three paths, so a chat
 * started at `/` keeps what is on screen when the server gives it an id and
 * the URL becomes `/c/<id>`.
 */
export function ChatPage() {
	const { id = null, folderId = null } = useParams();
	const [search, setSearch] = useSearchParams();
	const token = useAuthStore((s) => s.token) ?? '';
	const user = useAuthStore((s) => s.user);
	const config = useConfigStore((s) => s.config);
	const { settings } = useUserSettings();
	const { models, loaded } = useModels();

	const folder = useQuery({ queryKey: ['folder', folderId], enabled: Boolean(folderId), retry: false, queryFn: async () => (await getFolderById(token, folderId!)) as Folder });

	const chatPerms = (user?.permissions as { chat?: Record<string, boolean> } | undefined)?.chat ?? {};
	const admin = user?.role === 'admin';
	const temporaryAllowed = admin || Boolean(chatPerms.temporary);
	const temporaryEnforced = !admin && Boolean(chatPerms.temporary_enforced);
	const [temporary, setTemporary] = useState(() => temporaryEnforced || search.get('temporary-chat') === 'true');
	const [selectedModels, setSelectedModels] = useState<string[]>([]);
	const [toggles] = useState({ webSearch: search.get('web-search') === 'true', imageGeneration: search.get('image-generation') === 'true', codeInterpreter: search.get('code-interpreter') === 'true' });

	const session = useChatSession({ routeChatId: id, folderId, models, selectedModels, temporary: temporary && !id, toggles, toolIds: [] });
	const input = useRef<ChatInputHandle>(null);
	const scroller = useRef<HTMLDivElement>(null);
	const atBottom = useRef(true);

	useDocumentTitle(session.title || 'New Chat');

	// A folder that cannot be read: say why and go home (folders/[folderId]/+page.svelte).
	const navigate = useNavigate();
	useEffect(() => {
		if (!folder.isError) return;
		toast.error(`${folder.error}`);
		navigate('/', { replace: true });
	}, [folder.isError, folder.error, navigate]);

	// A saved chat brings its own models; a new one picks them (URL, folder, user, defaults).
	const pickedFor = useRef<string | null>(null);
	useEffect(() => {
		if (!loaded) return;
		if (id) {
			const saved = session.chat?.chat?.models as string[] | undefined;
			if (saved && pickedFor.current !== id) {
				pickedFor.current = id;
				setSelectedModels(admin || (chatPerms.multiple_models ?? true) ? saved : saved.slice(0, 1));
			}
			return;
		}
		if (folderId && !folder.isFetched) return;
		const key = `new:${folderId ?? ''}`;
		if (pickedFor.current === key) return;
		pickedFor.current = key;
		setSelectedModels(initialModels({ url: search.get('models') || search.get('model'), folderModels: folder.data?.data?.model_ids, userModels: (settings as { models?: string[] } | null)?.models, defaults: (config as { default_models?: string } | null)?.default_models, models }));
		// Only when the chat or the model list changes.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [loaded, id, folderId, folder.isFetched, session.chat]);

	// `?q=` fills the input and (unless `submit=false`) sends it, once models are chosen.
	const consumed = useRef(false);
	useEffect(() => {
		const q = search.get('q');
		if (!q || consumed.current || id || !selectedModels.length || !selectedModels[0]) return;
		consumed.current = true;
		if ((search.get('submit') ?? 'true') === 'true') session.submit(q);
		else input.current?.setText(q);
		const next = new URLSearchParams(search);
		next.delete('q');
		next.delete('submit');
		setSearch(next, { replace: true });
	}, [search, id, selectedModels, session, setSearch]);

	// Stay pinned to the newest message while it streams, unless the reader scrolled up.
	useLayoutEffect(() => {
		const el = scroller.current;
		if (el && atBottom.current) el.scrollTop = el.scrollHeight;
	}, [session.history]);

	const onBranch = useCallback(
		(h: History) => {
			session.setHistory(h);
			void session.save(h);
		},
		[session]
	);

	const actions = useMessageActions(session);
	const [citation, setCitation] = useState<Citation | null>(null);
	const handlers: MessageHandlers = {
		...actions,
		onBranch,
		citationsFor: (modelId) => models.find((m) => m.id === modelId)?.info?.meta?.capabilities?.citations !== false,
		onRegenerate: (m) => void session.regenerate(m),
		onFollowUp: (text) => {
			atBottom.current = true;
			session.submit(text);
		},
		onToolCallResolved: () => void session.reload(),
		// A citation `[n]` (or `n#chunk`) is the n-th grouped source, 1-based.
		onSourceClick: (m, id) => setCitation(citationsOf(m.sources)[citationIndex(id)] ?? null)
	};

	const changeModels = (ids: string[]) => {
		setSelectedModels(ids);
		if (id && !session.generating) void updateChatById(token, id, { models: ids }).catch((e) => toast.error(`${e}`));
	};

	const empty = !session.history.currentId;
	const firstModel = models.find((m) => m.id === selectedModels[0]);


	return (
		<div className="flex h-full min-h-0 w-full flex-col">
			<header className="flex items-start gap-2 px-4 py-2">
				<ModelSelector models={models} selected={selectedModels} onChange={changeModels} disabled={session.generating} />
				<div className="ml-auto flex items-center gap-2 pt-1">
					{folder.data && <span className="text-muted-foreground text-sm" data-testid="chat-folder">{folder.data.name}</span>}
					{!id && temporaryAllowed && (
						<Tip content={temporary ? 'Temporary Chat is on' : 'Temporary Chat'}>
							<button
								type="button"
								aria-label="Temporary Chat"
								aria-pressed={temporary}
								disabled={temporaryEnforced}
								onClick={() => setTemporary((t) => !t)}
								className={cn('hover:bg-muted rounded-lg p-1.5', temporary ? 'text-foreground' : 'text-muted-foreground')}
							>
								<EyeOff className="size-4" />
							</button>
						</Tip>
					)}
				</div>
			</header>

			{session.loading ? (
				<div className="flex flex-1 items-center justify-center">
					<Spinner className="size-5" />
				</div>
			) : empty ? (
				<ChatPlaceholder
					model={firstModel}
					temporary={temporary && !id}
					onSelect={(prompt) => {
						atBottom.current = true;
						session.submit(prompt);
					}}
				/>
			) : (
				<div
					ref={scroller}
					className="min-h-0 flex-1 overflow-y-auto"
					data-testid="chat-messages"
					onScroll={(e) => {
						const el = e.currentTarget;
						atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
					}}
				>
					<ChatMessages history={session.history} h={handlers} chatId={session.chatId} />
				</div>
			)}

			<ChatInput
				ref={input}
				generating={session.generating}
				queued={session.queue}
				onRemoveQueued={session.removeQueued}
				onStop={() => void session.stop()}
				onSubmit={(text, files) => {
					atBottom.current = true;
					return session.submit(text, files);
				}}
			/>
			<ServerDialogs dialog={session.dialog} onClose={session.closeDialog} />
			<CitationDialog source={citation} onClose={() => setCitation(null)} />
		</div>
	);
}
