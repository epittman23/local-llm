import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, EyeOff, Search, SlidersHorizontal, SquarePen } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { Gone, isNotFound } from '@/components/common/Gone';
import { LoadFailed } from '@/components/common/LoadFailed';
import { SafeMarkdown } from '@/components/common/SafeMarkdown';
import { Spinner } from '@/components/common/Spinner';
import { Tip } from '@/components/common/Tip';
import { ShellBarPortal } from '@/components/layout/ShellBarSlot';
import { SidePanel, useMdUp } from '@/components/layout/SidePanel';
import { Button } from '@/components/ui/button';
import { canUseFeature } from '@/lib/access/features';
import { updateChatById } from '@/lib/apis/chats';
import { getFolderById } from '@/lib/apis/folders';
import { PENDING_WORKSPACE_IDS_KEY } from '@/lib/apis/sandbox';
import { getTools } from '@/lib/apis/tools';
import {
	canUploadFiles,
	canUploadWeb,
	featureButtons,
	modelDefaults,
	warnModelsWithoutVision
} from '@/lib/chat/attachments';
import { codeRunner } from '@/lib/chat/codeRun';
import type { ChatFile, History } from '@/lib/chat/history';
import { cssUrl } from '@/lib/chat/prefs';
import { needsWebSearchConfirm, newChatTemporary, webSearchConfirmText } from '@/lib/chat/request';
import { type Citation, citationIndex, citationsOf } from '@/lib/chat/sources';
import { useUserSettings } from '@/lib/settings/userSettings';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore, useDocumentTitle } from '@/lib/stores/configStore';
import { useSettingsModalStore } from '@/lib/stores/settingsModalStore';
import { useUIStore } from '@/lib/stores/uiStore';
import { ArtifactDownload, ArtifactPanel } from './ArtifactPanel';
import { ChatBanners } from './ChatBanners';
import { ChatControls } from './ChatControls';
import { ChatInput, type ChatInputHandle } from './ChatInput';
import { ChatMenu } from './ChatMenu';
import { ChatMessages, type MessageHandlers } from './ChatMessages';
import { ChatPlaceholder } from './ChatPlaceholder';
import { ChatTitle, RenameChatDialog } from './ChatTitle';
import { CitationDialog } from './CitationDialog';
import { FolderHome } from './FolderHome';
import { AttachMenu, IntegrationsMenu, type Toggles } from './InputMenus';
import { useMessageActions } from './MessageActions';
import { ModelSelector } from './ModelSelector';
import { ServerDialogs } from './ServerDialogs';
import { useAttachments } from './useAttachments';
import { useChatPrefs } from './useChatPrefs';
import { useChatSession } from './useChatSession';
import { useHeldSend } from './useHeldSend';
import { useModelPick } from './useModelPick';
import { type ChatModel, useModels } from './useModels';
import { useOnChatSwitch } from './useOnChatSwitch';
import { useParamsAutosave } from './useParamsAutosave';

type Folder = { id: string; name: string; data?: { model_ids?: string[]; system_prompt?: string } | null };

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
	const { models } = useModels();

	const folder = useQuery({
		queryKey: ['folder', folderId],
		enabled: Boolean(folderId),
		retry: false,
		queryFn: async () => (await getFolderById(token, folderId!)) as Folder
	});

	const chatPerms = (user?.permissions as { chat?: Record<string, boolean> } | undefined)?.chat ?? {};
	const admin = user?.role === 'admin';
	const temporaryAllowed = admin || Boolean(chatPerms.temporary);
	const temporaryEnforced = !admin && Boolean(chatPerms.temporary_enforced);
	const prefs = useChatPrefs();
	const temporaryDefault = newChatTemporary({
		enforced: temporaryEnforced,
		allowed: temporaryAllowed,
		byDefault: prefs.temporaryByDefault
	});
	const [temporary, setTemporary] = useState(() => temporaryDefault || search.get('temporary-chat') === 'true');
	// Each new chat starts from the default (Chat.svelte's initNewChat), which
	// settings can change once they load. Declared before the ?temporary-chat
	// effect below, so that one still wins.
	useEffect(() => {
		if (!id) setTemporary(temporaryDefault);
	}, [id, temporaryDefault]);
	const [selectedModels, setSelectedModels] = useState<string[]>([]);
	const [toggles, setToggles] = useState<Toggles>({
		webSearch: search.get('web-search') === 'true',
		imageGeneration: search.get('image-generation') === 'true',
		codeInterpreter: search.get('code-interpreter') === 'true'
	});
	const [toolIds, setToolIds] = useState<string[]>(() =>
		(search.get('tools') ?? search.get('tool-ids') ?? '')
			.split(',')
			.map((t) => t.trim())
			.filter(Boolean)
	);
	const [atModel, setAtModel] = useState<ChatModel | null>(null);
	const tools = useQuery({
		queryKey: ['tools-for-chat'],
		enabled: Boolean(token),
		staleTime: 60_000,
		queryFn: async () => {
			// Only a list counts: an error body or a paged object must not reach `.map`.
			const res = await getTools(token).catch(() => null);
			return (Array.isArray(res) ? res : []) as { id: string; name: string; meta?: { description?: string } }[];
		}
	});
	const buttons = featureButtons(
		atModel ? [atModel.id] : selectedModels,
		models,
		user,
		(config?.features ?? {}) as Record<string, unknown>
	);

	const webSearchOn = toggles.webSearch && buttons.webSearch;
	const session = useChatSession({
		routeChatId: id,
		folderId,
		models,
		selectedModels,
		temporary: temporary && !id,
		toggles: {
			webSearch: webSearchOn,
			imageGeneration: toggles.imageGeneration && buttons.imageGeneration,
			codeInterpreter: toggles.codeInterpreter && buttons.codeInterpreter
		},
		toolIds
	});
	const attachments = useAttachments({ temporary: temporary && !id, selectedModels, models, chatId: session.chatId });
	const input = useRef<ChatInputHandle>(null);
	// Files attached and text typed in one chat are not carried into the next
	// (#217). Declared before the effects below that fill them for the chat now
	// opened (`?load-url=`, `?q=`), so it runs first.
	useOnChatSwitch(id, session.adoptedChatId, () => {
		attachments.clear();
		input.current?.setText('');
	});

	// One model selected: take its default tools and feature switches (Chat.svelte's setDefaults).
	const defaultsFor = useRef<string | null>(null);
	useEffect(() => {
		if (selectedModels.length !== 1 || !tools.isSuccess || defaultsFor.current === selectedModels[0]) return;
		defaultsFor.current = selectedModels[0];
		const d = modelDefaults(
			models.find((m) => m.id === selectedModels[0]),
			(tools.data ?? []).map((t) => t.id),
			(settings as { tools?: string[] } | null)?.tools,
			buttons
		);
		if (!search.get('tools') && !search.get('tool-ids')) setToolIds(d.toolIds);
		setToggles((t) => ({
			webSearch: (!id && prefs.webSearchAlways && buttons.webSearch) || (d.webSearch ?? t.webSearch),
			imageGeneration: d.imageGeneration ?? t.imageGeneration,
			codeInterpreter: d.codeInterpreter ?? t.codeInterpreter
		}));
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
	const scroller = useRef<HTMLDivElement>(null);
	const atBottom = useRef(true);

	// A rename made on this page shows at once in the header, the tab and the
	// phone bar; the session keeps the title it loaded until the chat reloads.
	const [renamed, setRenamed] = useState<{ id: string; title: string } | null>(null);
	const title = (id && renamed?.id === id ? renamed.title : null) ?? session.title;
	// Which chat's title is being edited, so opening another chat ends it.
	const [renamingId, setRenamingId] = useState<string | null>(null);
	const renaming = Boolean(id) && renamingId === id;
	const setRenaming = (on: boolean) => setRenamingId(on ? id : null);

	// A chat or folder that is not there says so in the tab as on the page (NAV-3).
	const chatGone = session.missing?.kind === 'not-found';
	const folderGone = folder.isError && isNotFound(folder.error);
	useDocumentTitle(
		chatGone
			? 'Chat not found'
			: folderGone
				? 'Folder not found'
				: // A folder's page is named after the folder (#998) until a chat started there has a title.
					folderId && folder.data && !title
					? folder.data.name
					: prefs.titleInTab
						? title || 'New chat'
						: null
	);
	const setSearchOpen = useUIStore((s) => s.setSearchOpen);
	const openSettings = useSettingsModalStore((s) => s.openSettings);

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
		warnModelsWithoutVision(
			atModel ? [atModel.id] : selectedModels,
			models,
			files,
			session.history,
			toggles.imageGeneration
		);
		const ok = session.submit(text, files, atModel?.id);
		if (ok) attachments.clear();
		return ok;
	};
	/** Sends a new prompt, or first asks to confirm web search; false keeps it in the input meanwhile. */
	const requestSend = (text: string, files: ChatFile[] = [], fromInput = false) => {
		// An empty prompt goes straight to send's own "Please enter a prompt".
		if (!needsWebSearchConfirm(config, webSearchOn, searchConfirmed) || (!text.trim() && !files.length))
			return send(text, files);
		setPendingSend({ text, files, fromInput });
		return false;
	};
	/** A suggestion or follow-up: sent, or put in the input when the user prefers that. */
	const applyPrompt = (text: string, insert: boolean) => {
		if (!insert) return void requestSend(text);
		input.current?.setText(text);
		input.current?.focus();
	};

	// A saved chat brings its own models; a new one picks them (URL, folder, user, defaults).
	const modelsChosen = useModelPick(session.chat, folder, setSelectedModels);
	// A send before the page has chosen its models waits for them, and for the tools
	// whose defaults they may turn on, in the box, which says so (#373, #659).
	const heldSend = useHeldSend(
		modelsChosen && (tools.isSuccess || tools.isError),
		id ?? `new:${folderId ?? ''}`,
		(text, files) => requestSend(text, files, true),
		() => input.current?.submit()
	);

	// `?temporary-chat=true` (also the New Temporary Chat shortcut) switches a new chat to temporary.
	useEffect(() => {
		if (search.get('temporary-chat') !== 'true' || id) return;
		if (temporaryAllowed) setTemporary(true);
		const next = new URLSearchParams(search);
		next.delete('temporary-chat');
		setSearch(next, { replace: true });
	}, [search, id, temporaryAllowed, setSearch]);

	// `?q=` fills the input and (unless `submit=false`) sends it, once models are
	// chosen. The send waits like an early one, so it goes with the models'
	// default tools and switches, set in this same commit (#659).
	const consumed = useRef(false);
	const holdSend = heldSend.hold;
	useEffect(() => {
		const q = search.get('q');
		if (!q || consumed.current || id || !selectedModels.length || !selectedModels[0]) return;
		consumed.current = true;
		input.current?.setText(q);
		if ((search.get('submit') ?? 'true') === 'true') holdSend();
		const next = new URLSearchParams(search);
		next.delete('q');
		next.delete('submit');
		setSearch(next, { replace: true });
	}, [search, id, selectedModels, holdSend, setSearch]);

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
	const saveParams = useParamsAutosave(id, token);
	const [preview, setPreview] = useState<string | null>(null);
	useEffect(() => setPreview(null), [id]);
	// Controls opened by its shortcut takes the side panel from a preview.
	useEffect(() => {
		if (controlsOpen) setPreview(null);
	}, [controlsOpen]);

	const actions = useMessageActions(session);
	const [citation, setCitation] = useState<Citation | null>(null);
	const queryClient = useQueryClient();
	const runner = codeRunner(config, token, user);
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
		// A run may have hit the workspace limit: the deletion dialog asks for the waiting workspaces again.
		onRun:
			runner &&
			((code, chatId) =>
				runner(code, chatId).finally(
					() => void queryClient.invalidateQueries({ queryKey: PENDING_WORKSPACE_IDS_KEY })
				)),
		// A citation `[n]` (or `n#chunk`) is the n-th grouped source, 1-based.
		onSourceClick: (m, id) => setCitation(citationsOf(m.sources)[citationIndex(id)] ?? null)
	};

	const changeModels = (ids: string[]) => {
		setSelectedModels(ids);
		if (id && !session.generating) void updateChatById(token, id, { models: ids }).catch((e) => toast.error(`${e}`));
	};

	const empty = !session.history.currentId;
	const firstModel = models.find((m) => m.id === selectedModels[0]);

	// A link to a chat or folder that is not there says so in place and keeps
	// its URL (NAV-3); one that failed to load offers to try again (STA-4).
	const searchChats = (
		<Button variant="outline" onClick={() => setSearchOpen(true)}>
			<Search aria-hidden /> Search chats
		</Button>
	);
	const newChat = (
		<Button asChild>
			<Link to="/">
				<SquarePen aria-hidden /> New chat
			</Link>
		</Button>
	);
	const gone = chatGone ? (
		<Gone
			level={2}
			title="This chat no longer exists."
			description="It may have been deleted or archived, or the link may be mistyped."
			actions={
				<>
					{newChat}
					{searchChats}
					<Button variant="outline" onClick={() => openSettings('archived_chats')}>
						<Archive aria-hidden /> Archived chats
					</Button>
				</>
			}
		/>
	) : session.missing ? (
		<LoadFailed
			what="this chat"
			error={session.missing.error}
			onRetry={() => void session.reload()}
			retrying={session.loading}
		/>
	) : folderGone ? (
		<Gone
			title="This folder no longer exists."
			description="It may have been deleted, or the link may be mistyped."
			actions={
				<>
					{newChat}
					{searchChats}
				</>
			}
		/>
	) : folder.isError ? (
		<LoadFailed
			what="this folder"
			error={folder.error}
			onRetry={() => void folder.refetch()}
			retrying={folder.isFetching}
		/>
	) : null;
	const isMd = useMdUp();
	const iconSize = isMd ? 'icon-sm' : 'icon';
	const modelSelector = (
		<ModelSelector models={models} selected={selectedModels} onChange={changeModels} disabled={session.generating} />
	);
	const headerActions = (
		<>
			{!id && temporaryAllowed && (
				<Tip content={temporary ? 'Temporary Chat is on' : 'Temporary Chat'}>
					<Button
						type="button"
						aria-label="Temporary Chat"
						aria-pressed={temporary}
						disabled={temporaryEnforced}
						onClick={() => setTemporary((t) => !t)}
						variant={temporary ? 'secondary' : 'ghost'}
						size={iconSize}
					>
						<EyeOff className="size-4" />
					</Button>
				</Tip>
			)}
			<Tip content="Controls">
				<Button
					type="button"
					aria-label="Controls"
					aria-pressed={controlsOpen && preview === null}
					onClick={() => {
						setPreview(null);
						setControlsOpen(!controlsOpen);
					}}
					variant={controlsOpen && preview === null ? 'secondary' : 'ghost'}
					size={iconSize}
				>
					<SlidersHorizontal className="size-4" />
				</Button>
			</Tip>
			{id && <ChatMenu chatId={id} title={title} size={iconSize} onRename={() => setRenaming(true)} />}
		</>
	);
	if (gone) return <div className="flex h-full min-h-0 w-full flex-col justify-center overflow-y-auto">{gone}</div>;

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
					<div
						aria-hidden
						data-testid="chat-background"
						className="pointer-events-none absolute inset-0 -z-10 bg-cover bg-center bg-no-repeat"
						style={{ backgroundImage: cssUrl(prefs.backgroundImageUrl) }}
					>
						<div className="bg-background/85 absolute inset-0" />
					</div>
				)}
				{isMd ? (
					// On a phone, toasts and the connection banner start below this row (FBK-2).
					<header data-page-top className="flex items-start gap-2 px-4 py-2">
						{modelSelector}
						<div className="flex min-w-0 flex-1 items-center gap-2 pt-1">
							{id && (
								<ChatTitle
									chatId={id}
									title={title}
									editing={renaming}
									onEditingChange={setRenaming}
									onRenamed={(t) => setRenamed({ id, title: t })}
								/>
							)}
							<div className="ml-auto flex shrink-0 items-center gap-2">{headerActions}</div>
						</div>
					</header>
				) : (
					// A phone has one header row, the app bar (#1091): these go in its slot,
					// and the model picker goes in the composer's toolbar.
					<ShellBarPortal>{headerActions}</ShellBarPortal>
				)}
				{id && !isMd && (
					<RenameChatDialog
						chatId={id}
						title={title}
						open={renaming}
						onOpenChange={setRenaming}
						onRenamed={(t) => setRenamed({ id, title: t })}
					/>
				)}

				{session.loading ? (
					<div className="flex flex-1 items-center justify-center">
						<Spinner className="size-5" />
					</div>
				) : empty && folderId ? (
					// The folder's own page (#998): its name, instructions and chats, above the message box.
					folder.data ? (
						<FolderHome folder={folder.data} />
					) : (
						<div aria-hidden className="mx-auto w-full max-w-3xl flex-1 px-6 py-8" data-testid="folder-home-loading">
							<div className="bg-surface-3 h-7 w-48 animate-pulse rounded-lg" />
						</div>
					)
				) : empty ? (
					<>
						{!id && <ChatBanners />}
						<ChatPlaceholder
							model={firstModel}
							temporary={temporary && !id}
							onSelect={(prompt) => applyPrompt(prompt, prefs.insertSuggestion)}
						/>
					</>
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
							{!isMd && modelSelector}
							<AttachMenu
								onFiles={attachments.addFiles}
								onWeb={(urls) => void attachments.addWeb(urls)}
								onItem={attachments.addItem}
								canUpload={canUploadFiles(user)}
								canWeb={canUploadWeb(user)}
								notesEnabled={canUseFeature('notes', user, config)}
							/>
							<IntegrationsMenu
								tools={tools.data ?? []}
								toolIds={toolIds}
								onToolIds={setToolIds}
								buttons={buttons}
								toggles={toggles}
								onToggles={setToggles}
							/>
						</>
					}
					onSubmit={heldSend.send}
					waiting={heldSend.waiting}
					onCancelWaiting={heldSend.cancel}
					wide={prefs.widescreen}
					placeholder={folderId && folder.data ? `New chat in ${folder.data.name}` : undefined}
					// Until the chat on screen has loaded, a message would be built on the previous one (docs/history/code-review.md L11).
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
			{/* One side panel (CNV-2): the preview while one is open, else Controls. */}
			<SidePanel
				key={preview !== null ? 'preview' : 'controls'}
				open={preview !== null || controlsOpen}
				onClose={() => (preview !== null ? setPreview(null) : setControlsOpen(false))}
				{...(preview !== null
					? { title: 'Preview', storageKey: 'sidePanel.preview', defaultWidth: 448, minWidth: 320 }
					: { title: 'Controls', storageKey: 'sidePanel.controls', defaultWidth: 320, minWidth: 288 })}
				actions={preview !== null && <ArtifactDownload code={preview} />}
			>
				{preview !== null ? (
					<ArtifactPanel code={preview} />
				) : (
					<ChatControls
						params={session.params}
						onParams={(p) => {
							session.setParams(p);
							saveParams(p);
						}}
						files={session.chatFiles}
						admin={admin}
					/>
				)}
			</SidePanel>
		</div>
	);
}
