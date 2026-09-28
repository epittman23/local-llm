import { useQuery } from '@tanstack/react-query';
import { EyeOff, SlidersHorizontal } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { SafeMarkdown } from '@/components/common/SafeMarkdown';
import { Spinner } from '@/components/common/Spinner';
import { Tip } from '@/components/common/Tip';
import { getFolderById } from '@/lib/apis/folders';
import { updateChatById } from '@/lib/apis/chats';
import type { ChatFile, History } from '@/lib/chat/history';
import { cssUrl } from '@/lib/chat/prefs';
import { type Citation, citationIndex, citationsOf } from '@/lib/chat/sources';
import { initialModels, needsWebSearchConfirm, newChatTemporary, webSearchConfirmText } from '@/lib/chat/request';
import { canUploadFiles, canUploadWeb, featureButtons, modelDefaults } from '@/lib/chat/attachments';
import { canUseFeature } from '@/lib/access/features';
import { getTools } from '@/lib/apis/tools';
import { useUserSettings } from '@/lib/settings/userSettings';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore, useDocumentTitle } from '@/lib/stores/configStore';
import { useUIStore } from '@/lib/stores/uiStore';
import { cn } from '@/lib/utils';
import { ArtifactPanel } from './ArtifactPanel';
import { ChatControls } from './ChatControls';
import { ChatInput, type ChatInputHandle } from './ChatInput';
import { ChatMenu } from './ChatMenu';
import { AttachMenu, IntegrationsMenu, type Toggles } from './InputMenus';
import { useAttachments } from './useAttachments';
import { ChatMessages, type MessageHandlers } from './ChatMessages';
import { ChatPlaceholder } from './ChatPlaceholder';
import { CitationDialog } from './CitationDialog';
import { useMessageActions } from './MessageActions';
import { ModelSelector } from './ModelSelector';
import { ServerDialogs } from './ServerDialogs';
import { useChatPrefs } from './useChatPrefs';
import { useChatSession } from './useChatSession';
import { type ChatModel, useModels } from './useModels';

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
	const prefs = useChatPrefs();
	const temporaryDefault = newChatTemporary({ enforced: temporaryEnforced, allowed: temporaryAllowed, byDefault: prefs.temporaryByDefault });
	const [temporary, setTemporary] = useState(() => temporaryDefault || search.get('temporary-chat') === 'true');
	// Each new chat starts from the default (Chat.svelte's initNewChat), which
	// settings can change once they load. Declared before the ?temporary-chat
	// effect below, so that one still wins.
	useEffect(() => {
		if (!id) setTemporary(temporaryDefault);
	}, [id, temporaryDefault]);
	const [selectedModels, setSelectedModels] = useState<string[]>([]);
	const [toggles, setToggles] = useState<Toggles>({ webSearch: search.get('web-search') === 'true', imageGeneration: search.get('image-generation') === 'true', codeInterpreter: search.get('code-interpreter') === 'true' });
	const [toolIds, setToolIds] = useState<string[]>(() => (search.get('tools') ?? search.get('tool-ids') ?? '').split(',').map((t) => t.trim()).filter(Boolean));
	const [atModel, setAtModel] = useState<ChatModel | null>(null);
	const tools = useQuery({ queryKey: ['tools-for-chat'], enabled: Boolean(token), staleTime: 60_000, queryFn: async () => {
			// Only a list counts: an error body or a paged object must not reach `.map`.
			const res = await getTools(token).catch(() => null);
			return (Array.isArray(res) ? res : []) as { id: string; name: string; meta?: { description?: string } }[];
		}
	});
	const buttons = featureButtons(atModel ? [atModel.id] : selectedModels, models, user, (config?.features ?? {}) as Record<string, unknown>);

	const webSearchOn = toggles.webSearch && buttons.webSearch;
	const session = useChatSession({ routeChatId: id, folderId, models, selectedModels, temporary: temporary && !id, toggles: { webSearch: webSearchOn, imageGeneration: toggles.imageGeneration && buttons.imageGeneration, codeInterpreter: toggles.codeInterpreter && buttons.codeInterpreter }, toolIds });
	const attachments = useAttachments({ temporary: temporary && !id, selectedModels, models, chatId: session.chatId });

	// One model selected: take its default tools and feature switches (Chat.svelte's setDefaults).
	const defaultsFor = useRef<string | null>(null);
	useEffect(() => {
		if (selectedModels.length !== 1 || !tools.isSuccess || defaultsFor.current === selectedModels[0]) return;
		defaultsFor.current = selectedModels[0];
		const d = modelDefaults(models.find((m) => m.id === selectedModels[0]), (tools.data ?? []).map((t) => t.id), (settings as { tools?: string[] } | null)?.tools, buttons);
		if (!search.get('tools') && !search.get('tool-ids')) setToolIds(d.toolIds);
		setToggles((t) => ({ webSearch: (!id && prefs.webSearchAlways && buttons.webSearch) || (d.webSearch ?? t.webSearch), imageGeneration: d.imageGeneration ?? t.imageGeneration, codeInterpreter: d.codeInterpreter ?? t.codeInterpreter }));
		// When the chosen model changes.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [selectedModels, tools.isSuccess]);

	// "Web Search in Chat: Always" starts each new chat with search on (it stays
	// off where a selected model can't search: `buttons` checks that).
	useEffect(() => {
		if (!id && prefs.webSearchAlways) setToggles((t) => ({ ...t, webSearch: true }));
	}, [id, prefs.webSearchAlways]);

	// `?youtube=` (from /watch) and `?load-url=` attach that page to a new chat.
	const loadedUrl = useRef(false);
	useEffect(() => {
		if (loadedUrl.current || id) return;
		const yt = search.get('youtube');
		const url = yt ? `https://www.youtube.com/watch?v=${yt}` : search.get('load-url');
		if (!url) return;
		loadedUrl.current = true;
		void attachments.addWeb([url]);
		// Once.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [id]);
	const input = useRef<ChatInputHandle>(null);
	const scroller = useRef<HTMLDivElement>(null);
	const atBottom = useRef(true);

	useDocumentTitle(prefs.titleInTab ? session.title || 'New Chat' : null);

	/** Set by the reader's own actions (sending, switching versions) to move to the end once, whatever the auto-scroll setting. */
	const scrollOnce = useRef(false);

	// Web search confirmation (the admin's ENABLE_WEB_SEARCH_CONFIRMATION): asked
	// once per chat before the first prompt with search on, and again after
	// search is turned off and on (Chat.svelte's webSearchConfirmed).
	const [searchConfirmed, setSearchConfirmed] = useState(false);
	const [pendingSend, setPendingSend] = useState<{ text: string; files: ChatFile[]; fromInput: boolean } | null>(null);
	useEffect(() => {
		// A chat started here keeps its confirmation when the server names it.
		if (id && id === session.adoptedChatId) return;
		setSearchConfirmed(false);
		setPendingSend(null);
		// Only when the route moves to another chat.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [id]);
	useEffect(() => {
		if (!webSearchOn) setSearchConfirmed(false);
	}, [webSearchOn]);

	/** Sends a prompt now (true if it went, or was queued). */
	const send = (text: string, files: ChatFile[] = []) => {
		scrollOnce.current = true;
		const ok = session.submit(text, files, atModel?.id);
		if (ok) attachments.clear();
		return ok;
	};
	/** Sends a new prompt, or first asks to confirm web search; false keeps it in the input meanwhile. */
	const requestSend = (text: string, files: ChatFile[] = [], fromInput = false) => {
		// An empty prompt goes straight to send's own "Please enter a prompt".
		if (!needsWebSearchConfirm(config, webSearchOn, searchConfirmed) || (!text.trim() && !files.length)) return send(text, files);
		setPendingSend({ text, files, fromInput });
		return false;
	};
	/** A suggestion or follow-up: sent, or put in the input when the user prefers that. */
	const applyPrompt = (text: string, insert: boolean) => {
		if (!insert) return void requestSend(text);
		input.current?.setText(text);
		input.current?.focus();
	};

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
			// While switching chats `session.chat` is still the previous chat's
			// record for a render or two; only take models from this route's own.
			if (session.chat?.id !== id) return;
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

	// `?temporary-chat=true` (also the New Temporary Chat shortcut) switches a new chat to temporary.
	useEffect(() => {
		if (search.get('temporary-chat') !== 'true' || id) return;
		if (temporaryAllowed) setTemporary(true);
		const next = new URLSearchParams(search);
		next.delete('temporary-chat');
		setSearch(next, { replace: true });
	}, [search, id, temporaryAllowed, setSearch]);

	// `?q=` fills the input and (unless `submit=false`) sends it, once models are chosen.
	const consumed = useRef(false);
	useEffect(() => {
		const q = search.get('q');
		if (!q || consumed.current || id || !selectedModels.length || !selectedModels[0]) return;
		consumed.current = true;
		if ((search.get('submit') ?? 'true') === 'true') requestSend(q);
		else input.current?.setText(q);
		const next = new URLSearchParams(search);
		next.delete('q');
		next.delete('submit');
		setSearch(next, { replace: true });
	}, [search, id, selectedModels, session, setSearch]);

	// Stay pinned to the newest message while it streams, unless the reader
	// scrolled up or turned "Response Auto-Scroll" off; the reader's own
	// actions still move to the end once.
	useLayoutEffect(() => {
		const el = scroller.current;
		if (el && (scrollOnce.current || (prefs.scrollOnResponse && atBottom.current))) el.scrollTop = el.scrollHeight;
		scrollOnce.current = false;
	}, [session.history, prefs.scrollOnResponse]);

	const onBranch = useCallback(
		(h: History) => {
			if (prefs.scrollOnBranch) scrollOnce.current = true;
			session.setHistory(h);
			void session.save(h);
		},
		[session, prefs.scrollOnBranch]
	);

	// The controls panel edits the chat's own params; a saved chat keeps them (debounced).
	const controlsOpen = useUIStore((s) => s.controlsOpen);
	const setControlsOpen = useUIStore((s) => s.setControlsOpen);
	const paramsDirty = useRef(false);
	// Params edited in one chat are never saved into the next: the pending
	// debounce below is flushed to the chat being left, then cleared.
	const paramsFor = useRef<{ id: string | null; params: Record<string, any> }>({ id, params: session.params });
	useEffect(() => {
		const prev = paramsFor.current;
		if (prev.id !== id) {
			if (paramsDirty.current && prev.id) void updateChatById(token, prev.id, { params: prev.params }).catch((e) => toast.error(`${e}`));
			paramsDirty.current = false;
		}
		paramsFor.current = { id, params: session.params };
	}, [id, session.params, token]);
	useEffect(() => {
		if (!paramsDirty.current || !id) return;
		const t = setTimeout(() => {
			paramsDirty.current = false;
			void updateChatById(token, id, { params: session.params }).catch((e) => toast.error(`${e}`));
		}, 500);
		return () => clearTimeout(t);
	}, [session.params, id, token]);
	const [preview, setPreview] = useState<string | null>(null);
	useEffect(() => setPreview(null), [id]);

	const actions = useMessageActions(session);
	const [citation, setCitation] = useState<Citation | null>(null);
	const handlers: MessageHandlers = {
		...actions,
		onBranch,
		citationsFor: (modelId) => models.find((m) => m.id === modelId)?.info?.meta?.capabilities?.citations !== false,
		onRegenerate: (m) => void session.regenerate(m),
		onFollowUp: (text) => applyPrompt(text, prefs.insertFollowUp),
		onToolCallResolved: () => void session.reload(),
		onPreview: (code) => {
			setControlsOpen(false);
			setPreview(code);
		},
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
		<div className="flex h-full min-h-0 w-full">
			<div
				className="relative isolate flex h-full min-h-0 min-w-0 flex-1 flex-col"
				onDragOver={(e) => {
					if (e.dataTransfer.types.includes('Files')) e.preventDefault();
				}}
				onDrop={(e) => {
					if (!e.dataTransfer.files.length) return;
					e.preventDefault();
					attachments.addFiles(Array.from(e.dataTransfer.files));
				}}
			>
				{prefs.backgroundImageUrl && (
					// The user's chat background, behind a wash that keeps the text readable.
					<div aria-hidden data-testid="chat-background" className="pointer-events-none absolute inset-0 -z-10 bg-cover bg-center bg-no-repeat" style={{ backgroundImage: cssUrl(prefs.backgroundImageUrl) }}>
						<div className="bg-background/85 absolute inset-0" />
					</div>
				)}
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
						<Tip content="Controls">
							<button
								type="button"
								aria-label="Controls"
								aria-pressed={controlsOpen}
								onClick={() => {
									setPreview(null);
									setControlsOpen(!controlsOpen);
								}}
								className={cn('hover:bg-muted rounded-lg p-1.5', controlsOpen ? 'text-foreground' : 'text-muted-foreground')}
							>
								<SlidersHorizontal className="size-4" />
							</button>
						</Tip>
						{id && (
							<ChatMenu
								chatId={id}
								title={session.title}
								onControls={() => {
									setPreview(null);
									setControlsOpen(true);
								}}
							/>
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
						onSelect={(prompt) => applyPrompt(prompt, prefs.insertSuggestion)}
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
					files={attachments.files}
					onRemoveFile={attachments.remove}
					onAddItem={attachments.addItem}
					onAddWeb={(urls) => void attachments.addWeb(urls)}
					onPasteFiles={attachments.addFiles}
					models={models}
					atModel={atModel}
					onAtModel={setAtModel}
					toolbar={
						<>
							<AttachMenu onFiles={attachments.addFiles} onWeb={(urls) => void attachments.addWeb(urls)} onItem={attachments.addItem} canUpload={canUploadFiles(user)} canWeb={canUploadWeb(user)} notesEnabled={canUseFeature('notes', user, config)} />
							<IntegrationsMenu tools={tools.data ?? []} toolIds={toolIds} onToolIds={setToolIds} buttons={buttons} toggles={toggles} onToggles={setToggles} />
						</>
					}
					onSubmit={(text, files) => requestSend(text, files, true)}
					wide={prefs.widescreen}
					// Until the chat on screen has loaded, a message would be built on the previous one (docs/code-review.md L11).
					disabled={session.loading}
					onPasteText={prefs.largeTextAsFile ? (file) => attachments.addFiles([file], { context: 'full' }) : undefined}
				/>
				<ConfirmDialog
					open={pendingSend !== null}
					onOpenChange={(open) => !open && setPendingSend(null)}
					onCloseAutoFocus={(e) => {
						// Back to the message box, where the prompt still is after Cancel.
						e.preventDefault();
						input.current?.focus();
					}}
					title="Use Web Search?"
					confirmLabel="Continue"
					onConfirm={() => {
						const p = pendingSend;
						setSearchConfirmed(true);
						setPendingSend(null);
						if (p && send(p.text, p.files) && p.fromInput) input.current?.setText('');
					}}
				>
					<SafeMarkdown text={webSearchConfirmText(config)} className="text-sm" />
				</ConfirmDialog>
				<ServerDialogs dialog={session.dialog} onClose={session.closeDialog} />
				<CitationDialog source={citation} onClose={() => setCitation(null)} />
			</div>
			{preview !== null ? (
				<ArtifactPanel code={preview} onClose={() => setPreview(null)} />
			) : (
				controlsOpen && (
					<ChatControls
						params={session.params}
						onParams={(p) => {
							paramsDirty.current = true;
							session.setParams(p);
						}}
						files={session.chatFiles}
						onRemoveFile={(i) => session.setChatFiles(session.chatFiles.filter((_, j) => j !== i))}
						onClose={() => setControlsOpen(false)}
						admin={admin}
					/>
				)
			)}
		</div>
	);
}
