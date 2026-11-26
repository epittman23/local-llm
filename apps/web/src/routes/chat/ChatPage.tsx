import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, Search, SlidersHorizontal, SquarePen } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { overriddenCount } from '@/components/common/advancedParamDefs';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { toastFailure } from '@/components/common/failureToast';
import { Gone, isNotFound } from '@/components/common/Gone';
import { LoadFailed } from '@/components/common/LoadFailed';
import { SafeMarkdown } from '@/components/common/SafeMarkdown';
import { Spinner } from '@/components/common/Spinner';
import { Tip } from '@/components/common/Tip';
import { ShellBarPortal } from '@/components/layout/ShellBarSlot';
import { SidePanel, useLgUp, useMdUp } from '@/components/layout/SidePanel';
import { Button } from '@/components/ui/button';
import { canUseFeature } from '@/lib/access/features';
import { updateChatById } from '@/lib/apis/chats';
import { getFolderById } from '@/lib/apis/folders';
import { getNoteById } from '@/lib/apis/notes';
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
import { draftKeyFor } from '@/lib/chat/drafts';
import { type ChatFile, type History, messagesList } from '@/lib/chat/history';
import { cssUrl } from '@/lib/chat/prefs';
import { needsWebSearchConfirm, newChatTemporary, webSearchConfirmText } from '@/lib/chat/request';
import { type Citation, citationIndex, citationsOf } from '@/lib/chat/sources';
import { useUserSettings } from '@/lib/settings/userSettings';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore, useDocumentTitle } from '@/lib/stores/configStore';
import { useSettingsModalStore } from '@/lib/stores/settingsModalStore';
import { useUIStore } from '@/lib/stores/uiStore';
import { CanvasContext } from './canvas/CanvasContext';
import { CanvasPanel } from './canvas/CanvasPanel';
import { useCanvas } from './canvas/useCanvas';
import { useCanvasAutoOpen } from './canvas/useCanvasAutoOpen';
import type { NoteChatState } from '@/routes/notes/noteChat';
import { ChatBanners } from './ChatBanners';
import { ChatControls } from './ChatControls';
import { ChatInput, type ChatInputHandle } from './ChatInput';
import { ChatMenu } from './ChatMenu';
import { ChatMessages, type MessageHandlers } from './ChatMessages';
import { ChatPlaceholder } from './ChatPlaceholder';
import { ChatTitle, RenameChatDialog } from './ChatTitle';
import { CitationDialog } from './CitationDialog';
import { DropOverlay, useFileDrag } from './DropOverlay';
import { FolderHome } from './FolderHome';
import { AttachMenu, IntegrationsMenu, type Toggles } from './InputMenus';
import { JumpToLatest } from './JumpToLatest';
import { useMessageActions } from './MessageActions';
import { ModelSelector } from './ModelSelector';
import { openModelPicker } from './modelPickerStore';
import { ServerDialogs } from './ServerDialogs';
import { TemporaryNotice, TemporaryToggle, useLeaveWarning } from './TemporaryNotice';
import { uploadCountLimit, useAttachments } from './useAttachments';
import { useChatPrefs } from './useChatPrefs';
import { useChatSession } from './useChatSession';
import { useHeldSend } from './useHeldSend';
import { useModelPick } from './useModelPick';
import { type ChatModel, useModels } from './useModels';
import { useOnChatSwitch } from './useOnChatSwitch';
import { useParamsAutosave } from './useParamsAutosave';
import { useSavedAskUser } from './useSavedAskUser';

/** Below md on a short screen the app bar's buttons float over the top of the page (AppShell, A11Y-5). */
const SHORT_PHONE_TOP = 'max-md:[@media(max-height:520px)]:pt-12';

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
	const location = useLocation();
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
	// A reply paused on an ask_user call (native function calling) asks from the stored reply.
	const askUser = useSavedAskUser({
		history: session.history,
		chatId: session.chatId,
		token,
		onResolved: () => void session.reload()
	});
	const input = useRef<ChatInputHandle>(null);
	// Files attached and text typed in one chat are not carried into the next
	// (#217). Declared before the effects below that fill them for the chat now
	// opened (`?load-url=`, `?q=`), so it runs first.
	useOnChatSwitch(id, session.adoptedChatId, () => {
		attachments.clear();
		input.current?.restoreDraft();
		// A rename made here is in the title the next chat loads; one made since in the sidebar would be hidden.
		setRenamed(null);
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
	// The same, for the render: Jump to latest shows while the reader is away from the end (#929).
	const [awayFromEnd, setAwayFromEnd] = useState(false);
	const jumpToLatest = () => {
		const el = scroller.current;
		if (el) el.scrollTop = el.scrollHeight;
		atBottom.current = true;
		setAwayFromEnd(false);
	};

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
		// An empty model slot (old saved data): open its picker, which says what to do (FRM-2).
		const emptySlot = atModel ? -1 : selectedModels.indexOf('');
		if (emptySlot >= 0) {
			openModelPicker(emptySlot);
			return false;
		}
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

	// `?note=<id>` (a note's "Ask in a new chat", "Explain in a new chat") attaches that note to a
	// new chat the way Attach notes does, and a quoted selection from the note's page (navigation
	// state, not the URL) starts the composer's draft. Each is applied once and then taken out of
	// the history entry, so a reload or Back does not repeat it (#1135). Where notes are off, ignored;
	// on a saved chat the parameter is only dropped.
	const notesEnabled = canUseFeature('notes', user, config);
	const noteAsked = useRef<string | null>(null);
	const [pendingDraft, setPendingDraft] = useState<string | null>(null);
	const addNote = attachments.addItem;
	useEffect(() => {
		const noteId = search.get('note');
		if (!noteId) noteAsked.current = null;
		if (!noteId || !notesEnabled || noteAsked.current === noteId) return;
		noteAsked.current = noteId;
		const draft = (location.state as NoteChatState | null)?.draft;
		const next = new URLSearchParams(search);
		next.delete('note');
		setSearch(next, { replace: true, state: null });
		if (id) return;
		if (draft) setPendingDraft(draft);
		getNoteById(token, noteId)
			.then((note: { id: string; title?: string } | null) => {
				if (!note?.id) throw new Error('not found');
				addNote({ type: 'note', id: note.id, name: note.title || 'Untitled', description: 'Note' } as ChatFile);
			})
			.catch((error) =>
				toastFailure("Couldn't attach the note. It may have been deleted, or you may not have access to it.", error)
			);
	}, [search, id, notesEnabled, location.state, token, addNote, setSearch]);
	// The draft waits for the composer and for the models, as `?q=` does, and is spent only once it is in the box.
	useEffect(() => {
		if (pendingDraft === null || id || !input.current || !selectedModels[0]) return;
		input.current.setText(pendingDraft);
		input.current.focus();
		setPendingDraft(null);
	}, [pendingDraft, id, selectedModels]);

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
	// The canvas (CNV-1) and Controls share the one side panel (CNV-2): opening either closes the other.
	const branch = useMemo(() => messagesList(session.history, session.history.currentId), [session.history]);
	const isLg = useLgUp();
	const canvas = useCanvas(branch, session.loading);
	const canvasOpen = canvas.openId !== null;
	const autoOpened = useCanvasAutoOpen({
		history: branch,
		generating: session.generating,
		enabled: prefs.canvasAutoOpen,
		isLg,
		canvas
	});
	useEffect(() => {
		if (canvasOpen) setControlsOpen(false);
	}, [canvasOpen, setControlsOpen]);
	const controlsWas = useRef(controlsOpen);
	useEffect(() => {
		if (controlsOpen && !controlsWas.current && canvasOpen) canvas.close();
		controlsWas.current = controlsOpen;
	}, [controlsOpen, canvasOpen, canvas.close]);
	// A saved version of a document joins the next message (docs/plans/canvas.md, C16); a temporary chat has no
	// server files to attach, and the file limit counts it as any other.
	const inTemporary = temporary && !id;
	const maxFiles = uploadCountLimit(config as { file?: { max_count?: number | null } } | null);
	const attachedCount = attachments.files.length;
	const attachedIds = attachments.files.map((f) => f.id).join();
	const addAttachment = attachments.addItem;
	const attach = useCallback(
		(file: ChatFile) => {
			if (inTemporary) {
				toast.error('A temporary chat keeps no files to attach.');
				return false;
			}
			if (attachedIds.split(',').includes(String(file.id))) return true;
			if (maxFiles !== null && attachedCount + 1 > maxFiles) {
				toast.error(`You can only chat with a maximum of ${maxFiles} file(s) at a time.`);
				return false;
			}
			addAttachment(file);
			return true;
		},
		[inTemporary, maxFiles, attachedCount, attachedIds, addAttachment]
	);
	const canvasContext = useMemo(
		() => ({ openId: canvas.openId, open: canvas.open, attach }),
		[canvas.openId, canvas.open, attach]
	);

	const actions = useMessageActions(session);
	const [citation, setCitation] = useState<Citation | null>(null);
	const queryClient = useQueryClient();
	const runner = codeRunner(config, token, user);
	const handlers: MessageHandlers = {
		...actions,
		onBranch,
		citationsFor: (modelId) => models.find((m) => m.id === modelId)?.info?.meta?.capabilities?.citations !== false,
		onRegenerate: (m) => void session.regenerate(m),
		onTryAnotherModel: () => openModelPicker(),
		onFollowUp: (text) => applyPrompt(text, prefs.insertFollowUp),
		onToolCallResolved: () => void session.reload(),
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
	const fileDrag = useFileDrag();
	// A temporary chat with messages says so for as long as it lasts, and a reload asks first (#1080).
	const temporaryLive = temporary && !id && !empty;
	useLeaveWarning(temporaryLive);
	const iconSize = isMd ? 'icon-sm' : 'icon';
	const modelSelector = (
		<ModelSelector models={models} selected={selectedModels} onChange={changeModels} disabled={session.generating} />
	);
	const changedParams = overriddenCount(session.params);
	const headerActions = (
		<>
			{temporaryLive
				? isMd && <TemporaryNotice />
				: !id &&
					temporaryAllowed && (
						<TemporaryToggle
							on={temporary}
							disabled={temporaryEnforced}
							onToggle={() => setTemporary((t) => !t)}
							size={iconSize}
						/>
					)}
			<Tip content={changedParams ? `Controls: ${changedParams} changed` : 'Controls'}>
				<Button
					type="button"
					aria-label="Controls"
					// The dot says this chat's parameters differ from the defaults (#996).
					aria-description={changedParams ? `${changedParams} changed` : undefined}
					className="relative"
					aria-pressed={controlsOpen}
					onClick={() => setControlsOpen(!controlsOpen)}
					variant={controlsOpen ? 'secondary' : 'ghost'}
					size={iconSize}
				>
					<SlidersHorizontal className="size-4" />
					{changedParams > 0 && (
						<span
							aria-hidden
							data-testid="controls-changed"
							className="bg-brand absolute top-1 right-1 size-1.5 rounded-full"
						/>
					)}
				</Button>
			</Tip>
			{id && <ChatMenu chatId={id} title={title} size={iconSize} onRename={() => setRenaming(true)} />}
		</>
	);
	if (gone) return <div className="flex h-full min-h-0 w-full flex-col justify-center overflow-y-auto">{gone}</div>;

	return (
		<CanvasContext.Provider value={canvasContext}>
			<div className="flex h-full min-h-0 w-full">
				<div
					className="relative isolate flex h-full min-h-0 min-w-0 flex-1 flex-col"
					onDragEnter={fileDrag.onDragEnter}
					onDragLeave={fileDrag.onDragLeave}
					onDragOver={(e) => {
						if (e.dataTransfer.types.includes('Files')) e.preventDefault();
					}}
					onDrop={(e) => {
						fileDrag.onDrop();
						if (!e.dataTransfer.files.length) return;
						e.preventDefault();
						attachments.addFiles(Array.from(e.dataTransfer.files));
					}}
				>
					<DropOverlay shown={fileDrag.dragging} />
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
						// Where the column is too narrow for the picker beside the title and the
						// buttons (a side panel open at 768 or 1024 px), those wrap to a second
						// row rather than squeezing the title to nothing or spilling over the panel.
						<header data-page-top className="flex flex-wrap items-start gap-x-2 px-4 py-2">
							<div className="max-w-full min-w-0">{modelSelector}</div>
							<div className="flex min-w-48 flex-1 items-center gap-2 pt-1">
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
					) : empty ? (
						// On a short phone the bar's buttons float over the top: the page's first row starts below them (A11Y-5).
						<div className={`flex min-h-0 flex-1 flex-col ${SHORT_PHONE_TOP}`}>
							{folderId ? (
								// The folder's own page (#998): its name, instructions and chats, above the message box.
								folder.data ? (
									<FolderHome folder={folder.data} />
								) : (
									<div
										aria-hidden
										className="mx-auto w-full max-w-3xl flex-1 px-6 py-8"
										data-testid="folder-home-loading"
									>
										<div className="bg-surface-3 h-7 w-48 animate-pulse rounded-lg" />
									</div>
								)
							) : (
								<>
									{!id && <ChatBanners />}
									<ChatPlaceholder
										model={firstModel}
										temporary={temporary && !id}
										onSelect={(prompt) => applyPrompt(prompt, prefs.insertSuggestion)}
									/>
								</>
							)}
						</div>
					) : (
						<div
							ref={scroller}
							// The first message starts below the short phone's floating buttons, and scrolls under them.
							// `relative` makes this the containing block of the messages' absolutely placed parts (each
							// reply's `sr-only` text): without it they were placed against the column outside this
							// scroller, so they escaped its clipping and let the page scroll past the end of the chat.
							className={`relative min-h-0 flex-1 overflow-y-auto ${SHORT_PHONE_TOP}`}
							data-testid="chat-messages"
							onScroll={(e) => {
								const el = e.currentTarget;
								atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
								setAwayFromEnd(!atBottom.current);
							}}
						>
							<ChatMessages history={session.history} h={handlers} chatId={session.chatId} />
						</div>
					)}
					{!session.loading && !empty && (
						// Centred just above the composer, whatever its height.
						<div className="relative h-0">
							<JumpToLatest
								shown={awayFromEnd}
								streaming={session.generating}
								onJump={jumpToLatest}
								scroller={scroller}
								className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2"
							/>
						</div>
					)}

					{temporaryLive && !isMd && (
						// The phone bar has no room for it beside the chat's name: above the composer instead.
						<div className="flex justify-center px-4 pt-2">
							<TemporaryNotice />
						</div>
					)}
					<ChatInput
						ref={input}
						draftKey={user ? draftKeyFor(user.id, id, folderId) : undefined}
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
								{!isMd && (
									<div className="flex min-w-0">
										<ModelSelector
											compact
											models={models}
											selected={selectedModels}
											onChange={changeModels}
											disabled={session.generating}
										/>
									</div>
								)}
								<AttachMenu
									onFiles={attachments.addFiles}
									onWeb={(urls) => void attachments.addWeb(urls)}
									onItem={attachments.addItem}
									canUpload={canUploadFiles(user)}
									canWeb={canUploadWeb(user)}
									notesEnabled={notesEnabled}
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
						onPasteText={
							prefs.largeTextAsFile ? (file) => attachments.addFiles([file], { context: 'full' }) : undefined
						}
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
					{/* A dialog the server sent over the socket comes first; a stored ask_user question waits behind it. */}
					<ServerDialogs
						dialog={session.dialog ?? askUser.dialog}
						onClose={session.dialog ? session.closeDialog : askUser.close}
					/>
					<CitationDialog
						source={citation}
						onClose={() => setCitation(null)}
						// A file the chat already holds opens as that document, not as a second one.
						onOpenFile={(fileId) =>
							canvas.open(canvas.documents.some((d) => d.id === fileId) ? fileId : `file:${fileId}`)
						}
					/>
				</div>
				{/* One side panel (CNV-2): the canvas while a document is open, else Controls. */}
				<CanvasPanel canvas={canvas} focusOnOpen={canvas.openId !== autoOpened} editable={!inTemporary} />
				<SidePanel
					open={controlsOpen && !canvasOpen}
					onClose={() => setControlsOpen(false)}
					title="Controls"
					storageKey="sidePanel.controls"
					defaultWidth={320}
					minWidth={288}
				>
					<ChatControls
						params={session.params}
						onParams={(p) => {
							session.setParams(p);
							saveParams(p);
						}}
						files={session.chatFiles}
						admin={admin}
						defaults={(settings as { params?: Record<string, unknown> } | null)?.params}
					/>
				</SidePanel>
			</div>
		</CanvasContext.Provider>
	);
}
