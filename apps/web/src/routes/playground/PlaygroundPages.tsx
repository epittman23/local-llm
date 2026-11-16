import { useQuery } from '@tanstack/react-query';
import saveAs from 'file-saver';
import {
	CircleAlert,
	Download,
	FileCode,
	MinusCircle,
	MoreHorizontal,
	Pencil,
	SlidersHorizontal,
	Trash2,
	X
} from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { Outlet } from 'react-router';
import { toast } from 'sonner';
import { Markdown } from '@/components/chat/markdown/Markdown';
import { AdvancedParams } from '@/components/common/AdvancedParams';
import type { Params } from '@/components/common/advancedParamDefs';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { toastFailure } from '@/components/common/failureToast';
import { Spinner } from '@/components/common/Spinner';
import { Tip } from '@/components/common/Tip';
import { type SectionTab, SectionTabs } from '@/components/layout/SectionTabs';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { ImageButton } from '@/components/ui/image-button';
import { PageHeader } from '@/components/ui/page-header';
import { RowButton } from '@/components/ui/row-button';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { getModels } from '@/lib/apis';
import { imageEdits, imageGenerations } from '@/lib/apis/images';
import { textCompletion } from '@/lib/apis/openai';
import type { Message } from '@/lib/chat/history';
import { useUserSettings } from '@/lib/settings/userSettings';
import { formatChord } from '@/lib/shortcuts';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { useSettingsModalStore } from '@/lib/stores/settingsModalStore';
import { ErrorReply } from '@/routes/chat/ErrorReply';
import { FeatureGate } from '@/routes/common/FeatureGate';
import {
	appendAssistant,
	chatRequest,
	chatToExport,
	chatToText,
	completionRequest,
	formatStats,
	initialModel,
	type PlaygroundMessage
} from './playgroundModel';
import { usePlaygroundStore } from './playgroundStore';
import { useStreamRunner } from './useStreamRunner';

type ModelInfo = { id: string; name: string };

/** Ctrl+Enter, or ⌘↩ on a Mac: runs in all three tabs (#1031, NAV-5). */
const RUN_KEYS = formatChord('Cmd+Enter');
const RUN_SHORTCUTS = 'Control+Enter Meta+Enter';
const IMAGES_OFF = 'Image generation is off. Turn it on in Admin Settings > Images.';

/** Image generation is switched on for this install: the Images tab is shown only then (S6-D7). */
const useImagesOn = () => useConfigStore((s) => s.config?.features?.enable_image_generation === true);

/** Ports routes/(app)/playground/+layout.svelte: admin only, with Chat / Completions / Images tabs. */
export function PlaygroundLayout() {
	const imagesOn = useImagesOn();
	const tabs: SectionTab[] = [
		{ to: '/playground', label: 'Chat', end: true },
		{ to: '/playground/completions', label: 'Completions' },
		...(imagesOn ? [{ to: '/playground/images', label: 'Images' }] : [])
	];
	return (
		<FeatureGate feature="playground">
			<div className="flex h-full min-h-0 w-full flex-col">
				<div className="mb-3 flex flex-col gap-3 border-b px-4 pt-4">
					<div className="ps-[var(--shell-menu-inset,0px)]">
						<PageHeader title="Playground" description="Try a model with hand-written requests, outside of chat." />
					</div>
					<SectionTabs label="Playground" tabs={tabs} />
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto">
					<Outlet />
				</div>
			</div>
		</FeatureGate>
	);
}

/**
 * The models to pick from, and the tab's chosen one, kept with the tab's work
 * (#969). A tab starts on the user's first chosen model, else the admin default.
 */
function usePlaygroundModel(tab: 'chat' | 'completions') {
	const token = useAuthStore((s) => s.token) ?? '';
	const defaults = useConfigStore((s) => s.config?.default_models as string | undefined);
	const settings = useUserSettings();
	const models = useQuery({
		queryKey: ['models-all'],
		queryFn: async () => ((await getModels(token)) ?? []) as ModelInfo[]
	});
	const modelId = usePlaygroundStore((s) => s[tab].modelId);
	const setChat = usePlaygroundStore((s) => s.setChat);
	const setCompletions = usePlaygroundStore((s) => s.setCompletions);
	const setModelId = (id: string) => (tab === 'chat' ? setChat({ modelId: id }) : setCompletions({ modelId: id }));
	const start = initialModel(settings.settings?.models, defaults);
	useEffect(() => {
		if (!modelId && start) setModelId(start);
	});
	return { models: models.data ?? [], modelId, setModelId };
}

function ModelSelect({
	models,
	value,
	onChange
}: {
	models: ModelInfo[];
	value: string;
	onChange: (id: string) => void;
}) {
	return (
		<Select value={value || undefined} onValueChange={onChange}>
			<SelectTrigger
				aria-label="Model"
				size="sm"
				title={models.find((m) => m.id === value)?.name ?? value}
				className="w-full min-w-0 sm:w-64"
			>
				<SelectValue placeholder="Choose a model" />
			</SelectTrigger>
			<SelectContent position="popper" align="end">
				{value && !models.some((m) => m.id === value) && <SelectItem value={value}>{value}</SelectItem>}
				{models.map((m) => (
					<SelectItem key={m.id} value={m.id}>
						{m.name}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

/** Ctrl/Cmd+Enter runs; Escape stops a run (#1031). Keys pressed while composing text (an IME) are left alone. */
function runKeys(e: KeyboardEvent, { run, stop, running }: { run: () => void; stop: () => void; running: boolean }) {
	if (e.nativeEvent.isComposing) return;
	if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
		e.preventDefault();
		if (!running) run();
	} else if (e.key === 'Escape' && running) {
		e.preventDefault();
		e.stopPropagation();
		stop();
	}
}

/** Run (or Regenerate), naming its shortcut; Stop while a run goes. */
function RunButton({
	running,
	label = 'Run',
	disabled,
	onRun,
	onStop
}: {
	running: boolean;
	label?: string;
	disabled?: boolean;
	onRun: () => void;
	onStop: () => void;
}) {
	if (running)
		return (
			<Tip content="Stop (Esc)">
				<Button type="button" variant="outline" size="sm" aria-keyshortcuts="Escape" onClick={onStop}>
					Stop
				</Button>
			</Tip>
		);
	return (
		<Tip content={`${label} (${RUN_KEYS})`}>
			<Button type="button" size="sm" disabled={disabled} aria-keyshortcuts={RUN_SHORTCUTS} onClick={onRun}>
				{label}
			</Button>
		</Tip>
	);
}

/** Opens the request parameters (#1108: Completions has them too). */
function ControlsButton({ onOpen }: { onOpen: () => void }) {
	return (
		<Tip content="Controls">
			<Button type="button" variant="ghost" size="icon-sm" aria-label="Controls" onClick={onOpen}>
				<SlidersHorizontal className="size-3.5" aria-hidden />
			</Button>
		</Tip>
	);
}

function ControlsDialog({
	open,
	onOpenChange,
	params,
	onChange
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	params: Params;
	onChange: (params: Params) => void;
}) {
	const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-md">
				<DialogHeader>
					<DialogTitle className="text-sm font-medium">Controls</DialogTitle>
					<DialogDescription className="sr-only">Request parameters.</DialogDescription>
				</DialogHeader>
				<AdvancedParams params={params} onChange={onChange} admin={isAdmin} custom />
			</DialogContent>
		</Dialog>
	);
}

/** A failed run, where its reply would have been, with Retry (#968; the chat's failed reply, FBK-4). */
function FailedRun({ error, onRetry }: { error: string; onRetry: () => void }) {
	const message: Message = {
		id: 'playground-failure',
		parentId: null,
		childrenIds: [],
		role: 'assistant',
		content: '',
		error: { content: error }
	};
	return <ErrorReply message={message} onRetry={onRetry} />;
}

const roleName = (role: PlaygroundMessage['role']) => (role === 'user' ? 'User' : 'Assistant');

/**
 * One message of the transcript: rendered as the chat renders it (#934,
 * CNT-1), or its Markdown source in the mono face for editing. On a phone
 * the role sits above the text.
 */
function MessageRow({
	message,
	index,
	streaming,
	source,
	onToggleSource,
	onChange,
	onDelete,
	canDelete
}: {
	message: PlaygroundMessage;
	index: number;
	streaming: boolean;
	source: boolean;
	onToggleSource: () => void;
	onChange: (content: string) => void;
	onDelete: () => void;
	canDelete: boolean;
}) {
	const n = index + 1;
	// An empty message has nothing to render: it is shown as the field to write it in.
	const editing = (source || !message.content) && !streaming;
	const stats = formatStats(message.stats);
	return (
		<li className="group flex flex-col gap-1 sm:flex-row sm:gap-2">
			<div className="flex items-center justify-between gap-2 sm:contents">
				<div className="text-foreground-muted text-body px-2 sm:w-24 sm:shrink-0 sm:pt-2">{roleName(message.role)}</div>
				<div className="flex gap-1 sm:order-last sm:items-start">
					<Tip content={source ? 'Show it rendered' : 'Show the Markdown source'}>
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							aria-label={`Source of message ${n}`}
							aria-pressed={source}
							disabled={streaming || !message.content}
							onClick={onToggleSource}
						>
							<FileCode className="size-4" aria-hidden />
						</Button>
					</Tip>
					<Tip content="Delete message">
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							aria-label={`Delete message ${n}`}
							disabled={!canDelete}
							onClick={onDelete}
						>
							<MinusCircle className="size-4" aria-hidden />
						</Button>
					</Tip>
				</div>
			</div>
			<div className="min-w-0 flex-1">
				{editing ? (
					<textarea
						className="field-sizing-content font-code w-full resize-none overflow-hidden rounded-lg bg-transparent p-2 text-body"
						aria-label={`${message.role} message ${n}`}
						placeholder={`Enter ${message.role === 'user' ? 'a user' : 'an assistant'} message here`}
						rows={1}
						value={message.content}
						onChange={(e) => onChange(e.target.value)}
					/>
				) : streaming && !message.content ? (
					<p className="text-foreground-muted text-body flex items-center gap-2 p-2">
						<Spinner className="size-4" /> Waiting for the first token…
					</p>
				) : (
					<section aria-label={`${roleName(message.role)} message ${n}`} className="p-2">
						<Markdown id={`playground-${n}`} content={message.content} done={!streaming} />
					</section>
				)}
				{stats && <p className="text-foreground-muted text-dense px-2">{stats}</p>}
			</div>
		</li>
	);
}

/** Ports components/playground/Chat.svelte: a hand-built conversation (either role), system instructions, parameters, run and stream. */
export function PlaygroundChat() {
	const chat = usePlaygroundStore((s) => s.chat);
	const setChat = usePlaygroundStore((s) => s.setChat);
	const clearChat = usePlaygroundStore((s) => s.clearChat);
	const { models, modelId, setModelId } = usePlaygroundModel('chat');
	const { running, run, stop } = useStreamRunner();
	const { system, messages, draft, role, params, failure } = chat;
	const [showSystem, setShowSystem] = useState(false);
	const [showControls, setShowControls] = useState(false);
	const [confirmClear, setConfirmClear] = useState(false);
	// Which messages show their source; by position, as messages have no ids.
	const [sourceOf, setSourceOf] = useState<number[]>([]);
	const bottom = useRef<HTMLDivElement>(null);
	useEffect(() => {
		// A block body on purpose: Chromium's scrollIntoView now returns a Promise,
		// which an expression-bodied effect would hand React as its "cleanup".
		bottom.current?.scrollIntoView?.({ block: 'end' });
	}, [messages, failure]);

	const last = messages.at(-1);
	// #1076: with nothing new to send after a reply, Run regenerates that reply instead of adding to it.
	const regenerate = !draft && last?.role === 'assistant';
	const add = () => {
		if (!draft) return;
		setChat({
			messages: [...messages, { role, content: draft }],
			draft: '',
			role: role === 'user' ? 'assistant' : 'user'
		});
	};
	/** Sends `history` and streams the answer into a new assistant message: never onto an earlier one. */
	const start = async (history: PlaygroundMessage[]) => {
		if (!modelId) return void toast.error('Choose a model to run.');
		setChat({ messages: [...history, { role: 'assistant', content: '' }], draft: '', role: 'user', failure: null });
		const result = await run(chatRequest(modelId, system, history, params), (text) =>
			setChat((c) => ({ messages: appendAssistant(c.messages, text) }))
		);
		setChat((c) => {
			const next = [...c.messages];
			const reply = next.at(-1);
			if (reply?.role === 'assistant') {
				if (reply.content) next[next.length - 1] = { ...reply, stats: result.stats };
				else next.pop();
			}
			return { messages: next, failure: result.error };
		});
	};
	/** Everything before the last reply, when the last message is one: what Regenerate and Retry resend. */
	const beforeReply = () => (last?.role === 'assistant' ? messages.slice(0, -1) : messages);
	const submit = () => {
		if (draft) void start([...messages, { role, content: draft }]);
		else if (messages.length) void start(beforeReply());
	};
	const exportJson = () => {
		saveAs(
			new Blob([JSON.stringify(chatToExport(system, messages, modelId), null, 2)], { type: 'application/json' }),
			`playground-chat-${Date.now()}.json`
		);
		toast.success('Chat exported');
	};
	const exportText = () => {
		saveAs(new Blob([chatToText(system, messages)], { type: 'text/plain' }), `playground-chat-${Date.now()}.txt`);
		toast.success('Chat exported');
	};
	const remove = (idx: number) => {
		setChat({ messages: messages.filter((_, i) => i !== idx) });
		setSourceOf((s) => s.filter((i) => i !== idx).map((i) => (i > idx ? i - 1 : i)));
	};

	return (
		<div className="flex h-full flex-col px-2.5">
			<ControlsDialog
				open={showControls}
				onOpenChange={setShowControls}
				params={params}
				onChange={(p) => setChat({ params: p })}
			/>
			<ConfirmDialog
				open={confirmClear}
				onOpenChange={setConfirmClear}
				title="Clear conversation?"
				confirmLabel="Clear conversation"
				destructive
				onConfirm={() => {
					clearChat();
					setSourceOf([]);
				}}
			>
				{messages.length === 1 ? 'Its message' : `Its ${messages.length} messages`} and the system instructions are
				removed. This can't be undone.
			</ConfirmDialog>

			<div className="flex items-center gap-1.5">
				<div data-composite-field className="flex-1 rounded-lg border px-1.5 py-1 text-sm">
					<RowButton
						className="flex min-h-6 items-center justify-between gap-2 px-0 py-0 pointer-coarse:min-h-11"
						aria-expanded={showSystem}
						onClick={() => setShowSystem((v) => !v)}
					>
						<span className="ml-1.5 shrink-0">System Instructions</span>
						{!showSystem && system.trim() && (
							<span className="text-muted-foreground line-clamp-1 flex-1 text-left">{system}</span>
						)}
						<Pencil className="size-3.5 shrink-0" />
					</RowButton>
					{showSystem && (
						<textarea
							className="placeholder:text-foreground-muted mt-1 w-full resize-y bg-transparent px-1.5 text-sm"
							aria-label="System Instructions"
							rows={4}
							placeholder="You're a helpful assistant."
							value={system}
							onChange={(e) => setChat({ system: e.target.value })}
						/>
					)}
				</div>
				<DropdownMenu>
					<Tip content="More options">
						<DropdownMenuTrigger asChild>
							<Button type="button" variant="ghost" size="icon-sm" aria-label="More options">
								<MoreHorizontal className="size-3.5" aria-hidden />
							</Button>
						</DropdownMenuTrigger>
					</Tip>
					{/* As wide as its items, not its icon trigger: menu labels do not wrap (OVL-3). */}
					<DropdownMenuContent align="end" className="w-auto">
						<DropdownMenuItem disabled={messages.length === 0} onSelect={exportJson}>
							<Download /> Export chat (.json)
						</DropdownMenuItem>
						<DropdownMenuItem disabled={messages.length === 0} onSelect={exportText}>
							<Download /> Plain text (.txt)
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							variant="destructive"
							disabled={running || (messages.length === 0 && !system)}
							onSelect={() => setConfirmClear(true)}
						>
							<Trash2 /> Clear conversation
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto py-3">
				{messages.length === 0 ? (
					<p className="text-foreground-muted text-body px-2">
						No messages yet. Write one below and Run it, or Add messages in either role to build a conversation first.
					</p>
				) : (
					<ul className="space-y-3">
						{messages.map((m, idx) => (
							<MessageRow
								// Messages are edited in place and deleted by position; they have no ids.
								key={idx}
								message={m}
								index={idx}
								streaming={running && idx === messages.length - 1}
								source={sourceOf.includes(idx)}
								onToggleSource={() => setSourceOf((s) => (s.includes(idx) ? s.filter((i) => i !== idx) : [...s, idx]))}
								onChange={(content) =>
									setChat((c) => ({ messages: c.messages.map((x, i) => (i === idx ? { ...x, content } : x)) }))
								}
								onDelete={() => remove(idx)}
								canDelete={!running}
							/>
						))}
					</ul>
				)}
				{failure && !running && <FailedRun error={failure} onRetry={() => void start(beforeReply())} />}
				<div ref={bottom} />
			</div>

			<div className="pb-3">
				<div data-composite-field className="rounded-2xl border px-3 py-2">
					<textarea
						className="placeholder:text-foreground-muted field-sizing-content max-h-36 w-full resize-none bg-transparent text-sm"
						aria-label="New message"
						aria-keyshortcuts={RUN_SHORTCUTS}
						rows={2}
						placeholder={`Enter ${role === 'user' ? 'a user' : 'an assistant'} message here`}
						value={draft}
						onChange={(e) => setChat({ draft: e.target.value })}
						onKeyDown={(e) => runKeys(e, { run: submit, stop, running })}
					/>
					<div className="flex flex-wrap items-center justify-between gap-2">
						<SegmentedControl
							aria-label="Message role"
							value={role}
							onValueChange={(r) => setChat({ role: r })}
							options={[
								{ value: 'user', label: 'User' },
								{ value: 'assistant', label: 'Assistant' }
							]}
							className="sm:w-auto"
						/>
						<div className="flex w-full items-center gap-2 sm:w-auto">
							<div className="min-w-0 flex-1">
								<ModelSelect models={models} value={modelId} onChange={setModelId} />
							</div>
							<ControlsButton onOpen={() => setShowControls(true)} />
							{!running && (
								<Button type="button" variant="outline" size="sm" disabled={!draft} onClick={add}>
									Add
								</Button>
							)}
							<RunButton
								running={running}
								label={regenerate ? 'Regenerate' : 'Run'}
								disabled={!draft && messages.length === 0}
								onRun={submit}
								onStop={stop}
							/>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

/**
 * Ports components/playground/Completions.svelte, now a real text completion
 * (#1108, S6-D6=B): the model continues your text through the connection's
 * `/completions`, and its continuation is set apart after it until you add
 * it to your text.
 */
export function PlaygroundCompletions() {
	const state = usePlaygroundStore((s) => s.completions);
	const setCompletions = usePlaygroundStore((s) => s.setCompletions);
	const { models, modelId, setModelId } = usePlaygroundModel('completions');
	const { running, run, stop } = useStreamRunner(textCompletion);
	const { prompt, output, params, stats, failure } = state;
	const [showControls, setShowControls] = useState(false);
	const tail = useRef<HTMLDivElement>(null);
	useEffect(() => {
		tail.current?.scrollIntoView?.({ block: 'nearest' });
	}, [output]);
	const submit = async () => {
		if (!prompt) return;
		if (!modelId) return void toast.error('Choose a model to run.');
		setCompletions({ output: '', stats: null, failure: null });
		const result = await run(completionRequest(modelId, prompt, params), (text) =>
			setCompletions((c) => ({ output: c.output + text }))
		);
		setCompletions({ failure: result.error, stats: result.error ? null : result.stats });
	};
	const keep = () => setCompletions((c) => ({ prompt: c.prompt + c.output, output: '', stats: null }));
	const speed = formatStats(stats ?? undefined);
	return (
		<div className="flex h-full flex-col gap-2 px-2.5 pb-3">
			<ControlsDialog
				open={showControls}
				onOpenChange={setShowControls}
				params={params}
				onChange={(p) => setCompletions({ params: p })}
			/>
			<p className="text-foreground-muted text-body px-1">
				The model continues your text. It is sent as a text completion, with no roles and no system prompt.
			</p>
			<div data-composite-field className="flex min-h-0 flex-1 flex-col rounded-2xl border px-3 py-2">
				{/* Your text, then the continuation right after it, scrolling together. */}
				<div className="min-h-0 flex-1 overflow-y-auto">
					<textarea
						className="placeholder:text-foreground-muted field-sizing-content min-h-24 w-full resize-none bg-transparent text-body"
						aria-label="Text to continue"
						aria-keyshortcuts={RUN_SHORTCUTS}
						placeholder="The central limit theorem states that"
						value={prompt}
						onChange={(e) => setCompletions({ prompt: e.target.value })}
						onKeyDown={(e) => runKeys(e, { run: () => void submit(), stop, running })}
					/>
					{(output || running) && (
						<section aria-label="Continuation" className="mt-1">
							<p className="text-foreground-muted text-dense mb-1">Continuation</p>
							<p className="border-brand bg-surface-2 text-foreground-strong text-body rounded-r-lg border-l-2 px-3 py-2 break-words whitespace-pre-wrap">
								{output || (
									<span className="text-foreground-muted inline-flex items-center gap-2">
										<Spinner className="size-4" /> Waiting for the first token…
									</span>
								)}
							</p>
							<div ref={tail} />
						</section>
					)}
				</div>
				<div className="mt-2 flex items-center gap-2">
					<div className="min-w-0 flex-1">
						<ModelSelect models={models} value={modelId} onChange={setModelId} />
					</div>
					<ControlsButton onOpen={() => setShowControls(true)} />
					{output && !running && (
						<Tip content="Adds the continuation to your text, so the next run continues from its end">
							<Button type="button" variant="outline" size="sm" onClick={keep}>
								Add to text
							</Button>
						</Tip>
					)}
					<RunButton running={running} disabled={!prompt} onRun={() => void submit()} onStop={stop} />
				</div>
			</div>
			{speed && <p className="text-foreground-muted text-dense px-1">{speed}</p>}
			{failure && !running && <FailedRun error={failure} onRetry={() => void submit()} />}
		</div>
	);
}

const readAsDataUrl = (file: File) =>
	new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(file);
	});

/** Image generation is off (S6-D7): a direct link to the tab says so and where to turn it on (FBK-1). */
function ImagesOff() {
	const admin = useAuthStore((s) => s.user?.role === 'admin');
	const openSettings = useSettingsModalStore((s) => s.openSettings);
	return (
		<div className="border-border-divider bg-surface-1 mb-2 flex gap-2 rounded-panel border p-3" role="status">
			<CircleAlert className="text-foreground-muted mt-0.5 size-4 shrink-0" aria-hidden />
			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<p className="text-body font-strong">Image generation is off</p>
				<p className="text-body text-foreground-muted">Turn it on in Admin Settings &gt; Images to make images here.</p>
				{admin && (
					<div>
						<Button type="button" variant="outline" size="sm" onClick={() => openSettings('admin:images')}>
							Open Images settings
						</Button>
					</div>
				)}
			</div>
		</div>
	);
}

/**
 * Ports components/playground/Images.svelte: generate from a prompt, or edit
 * the images added below it. Results collect newest first; clicking one
 * downloads it.
 */
export function PlaygroundImages() {
	const token = useAuthStore((s) => s.token) ?? '';
	const imagesOn = useImagesOn();
	const prompt = usePlaygroundStore((s) => s.imagePrompt);
	const setPrompt = usePlaygroundStore((s) => s.setImagePrompt);
	const fileInput = useRef<HTMLInputElement>(null);
	const [sources, setSources] = useState<string[]>([]);
	const [results, setResults] = useState<{ url: string }[]>([]);
	const [loading, setLoading] = useState(false);

	const addFiles = async (files: FileList | File[] | null | undefined) => {
		const images = Array.from(files ?? []).filter((f) => f.type.startsWith('image/'));
		const urls = await Promise.all(images.map(readAsDataUrl));
		setSources((prev) => [...prev, ...urls]);
	};
	const submit = async () => {
		if (!imagesOn) return;
		if (!prompt.trim()) return void toast.error('Please enter a prompt');
		setLoading(true);
		try {
			const res = sources.length
				? await imageEdits(token, sources.length === 1 ? sources[0] : sources, prompt)
				: await imageGenerations(token, prompt);
			if (Array.isArray(res)) setResults((prev) => [...res, ...prev]);
		} catch (err) {
			// The server answers "no permission" when the feature is off (WRD-4: there is one owner).
			if (/permission/i.test(`${err}`)) toast.error(IMAGES_OFF);
			else toastFailure("Couldn't make the image", err);
		} finally {
			setLoading(false);
		}
	};
	const download = async (url: string, idx: number) => {
		try {
			saveAs(await (await fetch(url)).blob(), `image-${Date.now()}-${idx}.png`);
		} catch {
			toast.error('Failed to download image');
		}
	};

	return (
		<div className="flex h-full flex-col px-2.5">
			<div className="min-h-0 flex-1 overflow-y-auto p-1">
				{!imagesOn && <ImagesOff />}
				{results.length ? (
					<div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
						{results.map((img, idx) => (
							<ImageButton
								key={`${img.url}-${idx}`}
								aria-label={`Download image ${idx + 1}`}
								overlay={<Download className="size-5" />}
								onClick={() => download(img.url, idx)}
							>
								<img src={img.url} alt="" className="aspect-square w-full object-cover" />
							</ImageButton>
						))}
					</div>
				) : (
					imagesOn && (
						<div className="text-muted-foreground flex h-full items-center justify-center text-sm">
							Generated images will appear here
						</div>
					)
				)}
			</div>
			<div className="pb-3">
				<div data-composite-field className="rounded-2xl border px-3 py-2">
					{sources.length > 0 && (
						<div className="mb-2 flex flex-wrap gap-2">
							{sources.map((src, idx) => (
								<div key={`${src.length}-${idx}`} className="relative">
									<img src={src} alt="" className="size-10 rounded-xl object-cover" />
									<Button
										type="button"
										variant="outline"
										size="icon-xs"
										aria-label={`Remove image ${idx + 1}`}
										className="absolute -top-2 -right-2 rounded-full"
										onClick={() => setSources(sources.filter((_, i) => i !== idx))}
									>
										<X className="size-2.5" />
									</Button>
								</div>
							))}
						</div>
					)}
					<textarea
						className="placeholder:text-foreground-muted field-sizing-content max-h-36 w-full resize-none bg-transparent text-sm"
						aria-label="Image prompt"
						aria-keyshortcuts={RUN_SHORTCUTS}
						rows={2}
						placeholder={sources.length ? 'Describe the edit...' : 'Describe the image...'}
						value={prompt}
						onChange={(e) => setPrompt(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing && !loading) {
								e.preventDefault();
								submit();
							}
						}}
					/>
					<div className="mt-2 flex items-center justify-between gap-2">
						<input
							ref={fileInput}
							type="file"
							accept="image/*"
							multiple
							hidden
							aria-label="Add image files"
							onChange={(e) => {
								addFiles(e.target.files);
								e.target.value = '';
							}}
						/>
						<Button
							type="button"
							variant="secondary"
							size="sm"
							disabled={!imagesOn}
							onClick={() => fileInput.current?.click()}
							onDragOver={(e) => e.preventDefault()}
							onDrop={(e) => {
								e.preventDefault();
								addFiles(e.dataTransfer.files);
							}}
						>
							Add Image
						</Button>
						<Tip content={imagesOn ? `Run (${RUN_KEYS})` : undefined}>
							<Button
								type="button"
								size="sm"
								aria-keyshortcuts={RUN_SHORTCUTS}
								disabled={!imagesOn || loading || !prompt.trim()}
								onClick={submit}
							>
								{loading ? (
									<>
										<Spinner className="size-4" /> Running...
									</>
								) : (
									'Run'
								)}
							</Button>
						</Tip>
					</div>
				</div>
			</div>
		</div>
	);
}
