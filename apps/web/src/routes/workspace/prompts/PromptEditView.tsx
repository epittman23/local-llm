import { useQuery } from '@tanstack/react-query';
import { Check, ChevronLeft, Clipboard, History } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { AccessButton } from '@/components/common/AccessButton';
import { AccessControlModal } from '@/components/common/AccessControlModal';
import { EditorError, type EditorProblem } from '@/components/common/EditorError';
import { PromptHistoryMenu } from '@/components/common/PromptHistoryMenu';
import { Spinner } from '@/components/common/Spinner';
import { Tags } from '@/components/common/Tags';
import { Tip } from '@/components/common/Tip';
import { ProfileAvatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FieldMessage, fieldProps } from '@/components/ui/field-message';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RowButton } from '@/components/ui/row-button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { useAccessGrants } from '@/lib/access/useAccessGrants';
import {
	deletePromptHistoryVersion,
	getPromptHistory,
	getPromptTags,
	setProductionPromptVersion,
	updatePromptAccessGrants,
	updatePromptMetadata
} from '@/lib/apis/prompts';
import { WEBUI_API_BASE_URL } from '@/lib/constants';
import { useAuthStore } from '@/lib/stores/authStore';
import { useFieldErrors } from '@/lib/ui/useFieldErrors';
import { useUnsavedChanges } from '@/lib/ui/useUnsavedChanges';
import { cn, copyToClipboard } from '@/lib/utils';
import { formatSecondsTimestamp } from '@/lib/utils/dates';
import { useDebouncedCallback } from '@/lib/utils/useDebouncedCallback';
import { routePaths } from '@/routes/routePaths';
import { useSingleUser } from '@/routes/workspace/workspaceAccess';
import { CommandField } from './PromptCreateDialog';
import { commandProblem, type EditablePrompt, INVALID_COMMAND, isValidCommand, type PromptDraft } from './promptTypes';

type HistoryEntry = {
	id: string;
	commit_message?: string | null;
	created_at: number;
	snapshot?: { content?: string };
	user?: { id: string; name: string };
};

const METADATA_SAVE_DELAY_MS = 500;

/**
 * Ports the edit half of workspace/Prompts/PromptEditor.svelte: the read-only
 * view of a prompt with its version history down the left, an Edit button
 * that opens a "save a new version" dialog, and name/command/tags that save
 * themselves 500ms after the last change.
 *
 * Reverting: if a metadata save fails (a command collision, typically) the
 * fields snap back to the last values that did save. A command that fails the
 * pattern check reverts only the command, without a round trip.
 */
export function PromptEditView({
	prompt,
	disabled,
	onSubmit
}: {
	prompt: EditablePrompt;
	disabled: boolean;
	onSubmit: (draft: PromptDraft) => Promise<void>;
}) {
	const token = useAuthStore((s) => s.token) ?? '';
	const user = useAuthStore((s) => s.user);
	const isAdmin = user?.role === 'admin';
	const navigate = useNavigate();

	const [name, setName] = useState(prompt.name);
	const [command, setCommand] = useState(prompt.command.startsWith('/') ? prompt.command.slice(1) : prompt.command);
	const [tags, setTags] = useState(prompt.tags.map((n) => ({ name: n })));
	const [accessGrants, changeAccess] = useAccessGrants(prompt.access_grants, (grants) =>
		updatePromptAccessGrants(token, prompt.id, grants)
	);
	const [versionId, setVersionId] = useState(prompt.version_id ?? null);
	const [showAccess, setShowAccess] = useState(false);
	const [showEdit, setShowEdit] = useState(false);
	const [contentCopied, setContentCopied] = useState(false);
	// At 390 the history is a sheet opened from the header (#957); at md and up, a column.
	const [showHistory, setShowHistory] = useState(false);
	const singleUser = useSingleUser();
	const ids = {
		name: useId(),
		command: useId(),
		commandMsg: useId(),
		content: useId(),
		contentMsg: useId(),
		message: useId(),
		problem: useId()
	};
	// FRM-2: the command's error under it. FRM-3 "at once": the line that says the fields saved.
	const [commandError, setCommandError] = useState<string | null>(null);
	const [metaStatus, setMetaStatus] = useState<'idle' | 'saved' | 'failed'>('idle');

	// The last metadata that the server accepted, for revert-on-failure.
	const saved = useRef({ name: prompt.name, command, tags });

	// The parent bumps `prompt.version_id` after a save; follow it.
	useEffect(() => setVersionId(prompt.version_id ?? null), [prompt.version_id]);

	const { data: suggestionTags } = useQuery({
		queryKey: ['prompt-tags'],
		queryFn: () => getPromptTags(token).catch(() => [] as string[])
	});

	// --- history ---------------------------------------------------------
	const [history, setHistory] = useState<HistoryEntry[]>([]);
	const [historyLoading, setHistoryLoading] = useState(false);
	const [selected, setSelected] = useState<HistoryEntry | null>(null);
	const page = useRef(0);
	const hasMore = useRef(true);
	const loadingRef = useRef(false);

	const loadHistory = useCallback(
		async (reset = false): Promise<HistoryEntry[]> => {
			if (loadingRef.current) return [];
			if (!reset && !hasMore.current) return [];
			loadingRef.current = true;
			setHistoryLoading(true);
			if (reset) {
				page.current = 0;
				hasMore.current = true;
			}
			let entries: HistoryEntry[] = [];
			try {
				entries = (await getPromptHistory(token, prompt.id, page.current)) ?? [];
				setHistory((prev) => (reset ? entries : [...prev, ...entries]));
				hasMore.current = entries.length > 0;
				page.current += 1;
			} catch (error) {
				console.error('Failed to load history:', error);
				if (reset) setHistory([]);
			}
			loadingRef.current = false;
			setHistoryLoading(false);
			return entries;
		},
		[token, prompt.id]
	);

	useEffect(() => {
		loadHistory(true).then((entries) => {
			if (entries.length === 0) return;
			// Open on the production version when there is one.
			setSelected((prompt.version_id && entries.find((h) => h.id === prompt.version_id)) || entries[0]);
		});
		// Once per prompt: later reloads are explicit (save, delete).
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [loadHistory]);

	const onHistoryScroll = (e: React.UIEvent<HTMLElement>) => {
		const el = e.currentTarget;
		if (el.scrollHeight - el.scrollTop <= el.clientHeight + 50 && hasMore.current) loadHistory(false);
	};

	// --- auto-saving metadata -------------------------------------------
	// Leaving the page saves a pending change at once instead of dropping it,
	// with keepalive when the page itself goes away (#675).
	const debouncedMetadataSave = useDebouncedCallback(
		async (next: { name: string; command: string; tags: { name: string }[] }, unloading: boolean) => {
			if (!isValidCommand(next.command)) {
				setCommandError(INVALID_COMMAND);
				return;
			}
			try {
				await updatePromptMetadata(
					token,
					prompt.id,
					next.name,
					next.command,
					next.tags.map((t) => t.name),
					unloading
				);
				saved.current = next;
				setCommandError(null);
				setMetaStatus('saved');
			} catch (error) {
				// A taken command stays in the field with the reason under it, to put right;
				// any other failure puts back what last saved and says so beside the fields.
				const taken = commandProblem(error, next.command);
				if (taken) {
					setCommandError(taken);
					return;
				}
				setName(saved.current.name);
				setCommand(saved.current.command);
				setTags(saved.current.tags);
				setMetaStatus('failed');
			}
		},
		METADATA_SAVE_DELAY_MS
	);
	const scheduleMetadataSave = (next: { name: string; command: string; tags: { name: string }[] }) => {
		if (!disabled) debouncedMetadataSave(next);
	};

	// --- new version -----------------------------------------------------
	const [content, setContent] = useState(prompt.content);
	const [commitMessage, setCommitMessage] = useState('');
	const [isProduction, setIsProduction] = useState(true);
	const [saving, setSaving] = useState(false);
	const [versionProblem, setVersionProblem] = useState<EditorProblem | null>(null);

	// After a save the parent hands down the new content.
	useEffect(() => setContent(prompt.content), [prompt.content]);

	// FRM-3: an open Edit prompt with changes is a draft. Closing the dialog (Esc, ×, the scrim)
	// or leaving the page asks first; the name, command and tags save at once and need no guard.
	const editDirty = showEdit && (content !== prompt.content || commitMessage !== '' || !isProduction);
	const guard = useUnsavedChanges(editDirty, {
		message: 'This version is not saved. What you changed is lost if you leave.'
	});
	// FRM-2: an empty prompt is said under the field (#1010), never in a browser bubble.
	const {
		errors: versionErrors,
		field: versionField,
		submit: checkVersion,
		reset: resetVersionErrors
	} = useFieldErrors(
		{ content: content.trim() ? undefined : 'Write the prompt: its command puts this text in the message.' },
		['content'] as const
	);
	const closeEdit = () => {
		setContent(prompt.content);
		setCommitMessage('');
		setIsProduction(true);
		setVersionProblem(null);
		resetVersionErrors();
		setShowEdit(false);
	};

	const saveNewVersion = async () => {
		if (disabled) return;
		setVersionProblem(null);
		if (!isValidCommand(command)) {
			setVersionProblem({
				message: `The command can't be saved: ${INVALID_COMMAND.toLowerCase()} Fix it first.`,
				detail: null
			});
			return;
		}
		setSaving(true);
		try {
			await onSubmit({
				id: prompt.id,
				name,
				command,
				content,
				tags: tags.map((t) => t.name),
				access_grants: accessGrants,
				commit_message: commitMessage || undefined,
				is_production: isProduction
			});
			setShowEdit(false);
			setCommitMessage('');
			setIsProduction(true);
			const entries = await loadHistory(true);
			if (entries.length > 0) setSelected(entries[0]);
		} catch (error) {
			setVersionProblem({
				message: commandProblem(error, command) ?? `Couldn't save the version. ${error}`,
				detail: null
			});
		}
		setSaving(false);
	};

	const setAsProduction = async (entry: HistoryEntry) => {
		if (disabled) return;
		try {
			await setProductionPromptVersion(token, prompt.id, entry.id);
			setVersionId(entry.id);
			// That version's content is live now, so a new version starts from it;
			// the dialog kept the previous one and saving would undo the switch (#222).
			if (entry.snapshot?.content !== undefined) setContent(entry.snapshot.content);
			toast.success(`The version from ${formatSecondsTimestamp(entry.created_at)} is now live`);
		} catch (error) {
			toast.error(`Couldn't make that version live. ${error}`);
		}
	};

	const deleteVersion = async (id: string) => {
		if (disabled) return;
		try {
			await deletePromptHistoryVersion(token, prompt.id, id);
			toast.success('Version deleted');
			const entries = await loadHistory(true);
			if (selected?.id === id) setSelected(entries[0] ?? null);
		} catch (error) {
			toast.error(`Couldn't delete the version. ${error}`);
		}
	};

	const shownContent = selected?.snapshot?.content || content;
	const copyContent = async () => {
		if (await copyToClipboard(shownContent)) {
			setContentCopied(true);
			setTimeout(() => setContentCopied(false), 2000);
		}
	};

	const historySection = (
		<div className="flex h-full flex-col">
			<div className="mb-2 shrink-0 text-xs text-muted-foreground">History</div>
			{history.length > 0 ? (
				<div className="flex-1 overflow-y-auto" onScroll={onHistoryScroll}>
					{history.map((entry) => {
						const active = selected?.id === entry.id;
						return (
							<RowButton
								key={entry.id}
								aria-current={active ? 'true' : undefined}
								className={cn(
									'relative px-1.5 py-1.5 pl-3',
									active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
								)}
								onClick={() => {
									setSelected(entry);
									setShowHistory(false);
								}}
							>
								<span
									className={cn(
										'absolute top-1.5 left-0 h-[calc(100%-0.75rem)] w-px rounded-full transition',
										active ? 'bg-foreground' : 'bg-transparent'
									)}
								/>
								<div className="mb-1 flex items-center gap-2">
									<div className="truncate text-xs">{entry.commit_message || 'Update'}</div>
									{entry.id === versionId && (
										<span className="text-muted-foreground inline-flex shrink-0 items-center text-xs">Live</span>
									)}
								</div>
								<div className="text-muted-foreground flex items-center gap-1 text-xs">
									{entry.user && (
										<>
											<ProfileAvatar
												src={`${WEBUI_API_BASE_URL}/users/${entry.user.id}/profile/image`}
												name={entry.user.name}
												size="sm"
												className="mr-0.5 size-5"
											/>
											<span className="truncate">{entry.user.name}</span>
											<span>•</span>
										</>
									)}
									<span className="shrink-0">{formatSecondsTimestamp(entry.created_at)}</span>
								</div>
							</RowButton>
						);
					})}
					{historyLoading && (
						<div className="flex justify-center py-2">
							<Spinner className="size-3" />
						</div>
					)}
				</div>
			) : (
				!historyLoading && (
					<div className="text-muted-foreground py-6 text-center text-xs italic">No history available</div>
				)
			)}
		</div>
	);

	return (
		<div className="flex h-full max-h-[100dvh] w-full flex-col">
			<AccessControlModal
				open={showAccess}
				onOpenChange={setShowAccess}
				accessGrants={accessGrants}
				accessRoles={['read', 'write']}
				share={Boolean(user?.permissions?.sharing?.prompts) || isAdmin}
				sharePublic={Boolean(user?.permissions?.sharing?.public_prompts) || isAdmin}
				shareUsers={(user?.permissions?.access_grants?.allow_users ?? true) || isAdmin}
				onChange={changeAccess}
			/>

			{guard.dialog}
			<Dialog open={showEdit} onOpenChange={(next) => (next ? setShowEdit(true) : guard.confirmLeave(closeEdit))}>
				<DialogContent className="sm:max-w-2xl">
					<DialogHeader>
						<DialogTitle>Edit prompt</DialogTitle>
						<DialogDescription>Saving keeps this version and adds a new one.</DialogDescription>
					</DialogHeader>
					<form
						className="flex flex-col gap-3"
						noValidate
						onSubmit={(e) => {
							e.preventDefault();
							if (checkVersion()) saveNewVersion();
						}}
					>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor={ids.content}>Prompt content</Label>
							<Textarea
								id={ids.content}
								className="max-h-[50dvh] resize-none"
								placeholder="e.g. Summarise {{topic}} in 50 words."
								rows={6}
								value={content}
								{...versionField('content')}
								{...fieldProps(ids.contentMsg, { error: versionErrors.content })}
								onChange={(e) => setContent(e.target.value)}
							/>
							<FieldMessage id={ids.contentMsg} error={versionErrors.content} />
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor={ids.message}>What changed (optional)</Label>
							<Input
								id={ids.message}
								placeholder="e.g. Asks for a shorter summary"
								value={commitMessage}
								onChange={(e) => setCommitMessage(e.target.value)}
							/>
						</div>
						{versionProblem && <EditorError id={ids.problem} problem={versionProblem} />}
						<div className="flex flex-wrap items-center justify-between gap-2">
							<label className="flex cursor-pointer items-center gap-2">
								<Checkbox checked={isProduction} onCheckedChange={(c) => setIsProduction(c === true)} />
								<span>Make it the live version</span>
							</label>
							<Button type="submit" disabled={saving} aria-busy={saving || undefined}>
								{saving && <Spinner className="size-3.5" />}
								Save new version
							</Button>
						</div>
					</form>
				</DialogContent>
			</Dialog>

			<Sheet open={showHistory} onOpenChange={setShowHistory}>
				<SheetContent side="right" className="w-[min(20rem,85vw)] p-4">
					<SheetHeader className="p-0">
						<SheetTitle>History</SheetTitle>
						<SheetDescription>Pick a version to see its content.</SheetDescription>
					</SheetHeader>
					<div className="min-h-0 flex-1 overflow-y-auto">{historySection}</div>
				</SheetContent>
			</Sheet>

			<div className="mb-1 flex shrink-0 flex-wrap items-center justify-between gap-2">
				<Button
					variant="ghost"
					size="sm"
					className="w-fit"
					type="button"
					onClick={() => navigate(routePaths.workspacePrompts)}
				>
					<ChevronLeft className="size-3" strokeWidth={2} />
					<span>Back</span>
				</Button>
				<div className="flex items-center gap-1.5 pr-0.5">
					<Button variant="outline" size="sm" className="md:hidden" type="button" onClick={() => setShowHistory(true)}>
						<History aria-hidden />
						History
					</Button>
					{disabled ? (
						<span className="bg-muted text-muted-foreground rounded-lg px-2 py-1 text-xs">Read Only</span>
					) : (
						<>
							<Button variant="outline" size="sm" type="button" onClick={() => setShowEdit(true)}>
								Edit
							</Button>
							{!singleUser && <AccessButton onClick={() => setShowAccess(true)} />}
						</>
					)}
				</div>
			</div>

			<div className="grid shrink-0 gap-3 pb-2 sm:grid-cols-2">
				<div className="flex min-w-0 flex-col gap-1.5">
					<Label htmlFor={ids.name}>Prompt name</Label>
					<Input
						id={ids.name}
						placeholder="e.g. Summarise a topic"
						value={name}
						disabled={disabled}
						onChange={(e) => {
							setName(e.target.value);
							scheduleMetadataSave({ name: e.target.value, command, tags });
						}}
					/>
				</div>
				<div className="flex min-w-0 flex-col gap-1.5">
					<Label htmlFor={ids.command}>Command</Label>
					<CommandField
						id={ids.command}
						value={command}
						disabled={disabled}
						{...fieldProps(ids.commandMsg, { error: commandError, help: true })}
						onChange={(value) => {
							setCommand(value);
							setCommandError(null);
							scheduleMetadataSave({ name, command: value, tags });
						}}
					/>
					<FieldMessage
						id={ids.commandMsg}
						error={commandError}
						help={
							disabled
								? `Type /${command} in a chat to use it.`
								: `Type /${command} in a chat to use it. The name, command and tags save as you change them.`
						}
					/>
				</div>
			</div>
			{!disabled && metaStatus !== 'idle' && (
				<p
					role="status"
					className={cn('text-dense shrink-0 pb-1', metaStatus === 'failed' ? 'text-danger' : 'text-foreground-muted')}
				>
					{metaStatus === 'saved' ? 'Saved' : "Couldn't save the name, command or tags. They are back as they were."}
				</p>
			)}

			<div className="mb-1 flex flex-wrap items-center justify-between gap-2">
				<div className="min-w-0 flex-1 basis-48">
					<Tags
						tags={tags}
						disabled={disabled}
						suggestionTags={suggestionTags ?? []}
						onAdd={(n) => {
							const next = [...tags, { name: n }];
							setTags(next);
							scheduleMetadataSave({ name, command, tags: next });
						}}
						onDelete={(n) => {
							const next = tags.filter((t) => t.name !== n);
							setTags(next);
							scheduleMetadataSave({ name, command, tags: next });
						}}
					/>
				</div>
				<Tip content="Click to copy ID">
					<Button
						variant="ghost"
						size="xs"
						className="max-w-56 min-w-0 shrink truncate font-mono"
						type="button"
						onClick={() => {
							copyToClipboard(prompt.id);
							toast.success('ID copied');
						}}
					>
						<span className="truncate">{prompt.id}</span>
					</Button>
				</Tip>
			</div>

			<div className="flex flex-1 flex-col gap-3 overflow-hidden pb-4 md:flex-row">
				<div className="hidden w-64 shrink-0 overflow-hidden md:flex md:flex-col">
					<div className="flex-1 overflow-y-auto">{historySection}</div>
				</div>

				<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
					<div className="mb-1 flex shrink-0 items-center justify-between">
						<div className="flex items-center gap-2">
							<div className="text-muted-foreground text-xs">Prompt content</div>
							{selected && (
								<span className="text-muted-foreground px-1 font-mono text-xs">{selected.id.slice(0, 7)}</span>
							)}
						</div>
						{selected && !disabled && (
							<div className="flex items-center gap-2">
								{selected.id === versionId ? (
									<span className="text-muted-foreground inline-flex items-center text-xs">Live</span>
								) : (
									<Button variant="link" size="xs" type="button" onClick={() => setAsProduction(selected)}>
										Set as Production
									</Button>
								)}
								<PromptHistoryMenu
									isProduction={selected.id === versionId}
									date={formatSecondsTimestamp(selected.created_at)}
									onDelete={() => deleteVersion(selected.id)}
								/>
							</div>
						)}
					</div>
					<div className="relative min-h-0 flex-1">
						<div className="absolute top-2 right-2 z-10">
							<Button variant="ghost" size="icon-sm" aria-label="Copy content" onClick={copyContent}>
								{contentCopied ? <Check className="text-success" /> : <Clipboard />}
							</Button>
						</div>
						<div className="bg-muted/40 h-full overflow-y-auto rounded-lg px-3 py-2">
							<pre className="pr-8 font-mono text-caption leading-relaxed whitespace-pre-wrap">{shownContent}</pre>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
