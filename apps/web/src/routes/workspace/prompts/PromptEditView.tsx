import { useQuery } from '@tanstack/react-query';
import { Check, ChevronLeft, Clipboard } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { AccessButton } from '@/components/common/AccessButton';
import { AccessControlModal } from '@/components/common/AccessControlModal';
import { PromptHistoryMenu } from '@/components/common/PromptHistoryMenu';
import { Spinner } from '@/components/common/Spinner';
import { Tags } from '@/components/common/Tags';
import { Tip } from '@/components/common/Tip';
import { Button } from '@/components/ui/button';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle
} from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
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
import { copyToClipboard, cn } from '@/lib/utils';
import { formatSecondsTimestamp } from '@/lib/utils/dates';
import { routePaths } from '@/routes/routePaths';
import { type EditablePrompt, type PromptDraft, isValidCommand } from './promptTypes';

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
	const [command, setCommand] = useState(
		prompt.command.startsWith('/') ? prompt.command.slice(1) : prompt.command
	);
	const [tags, setTags] = useState(prompt.tags.map((n) => ({ name: n })));
	const [accessGrants, setAccessGrants] = useState(prompt.access_grants);
	const [versionId, setVersionId] = useState(prompt.version_id ?? null);
	const [showAccess, setShowAccess] = useState(false);
	const [showEdit, setShowEdit] = useState(false);
	const [contentCopied, setContentCopied] = useState(false);

	// The last metadata that the server accepted, for revert-on-failure.
	const saved = useRef({ name: prompt.name, command, tags });
	const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => () => void (saveTimer.current && clearTimeout(saveTimer.current)), []);

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
			setSelected(
				(prompt.version_id && entries.find((h) => h.id === prompt.version_id)) || entries[0]
			);
		});
		// Once per prompt: later reloads are explicit (save, delete).
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [loadHistory]);

	const onHistoryScroll = (e: React.UIEvent<HTMLElement>) => {
		const el = e.currentTarget;
		if (el.scrollHeight - el.scrollTop <= el.clientHeight + 50 && hasMore.current) loadHistory(false);
	};

	// --- auto-saving metadata -------------------------------------------
	const scheduleMetadataSave = (next: {
		name: string;
		command: string;
		tags: { name: string }[];
	}) => {
		if (disabled) return;
		if (saveTimer.current) clearTimeout(saveTimer.current);
		saveTimer.current = setTimeout(async () => {
			if (!isValidCommand(next.command)) {
				toast.error('Only alphanumeric characters and hyphens are allowed in the command string.');
				setCommand(saved.current.command);
				return;
			}
			try {
				await updatePromptMetadata(
					token,
					prompt.id,
					next.name,
					next.command,
					next.tags.map((t) => t.name)
				);
				saved.current = next;
				toast.success('Saved');
			} catch (error) {
				toast.error(`${error}`);
				setName(saved.current.name);
				setCommand(saved.current.command);
				setTags(saved.current.tags);
			}
		}, METADATA_SAVE_DELAY_MS);
	};

	// --- new version -----------------------------------------------------
	const [content, setContent] = useState(prompt.content);
	const [commitMessage, setCommitMessage] = useState('');
	const [isProduction, setIsProduction] = useState(true);
	const [saving, setSaving] = useState(false);

	// After a save the parent hands down the new content.
	useEffect(() => setContent(prompt.content), [prompt.content]);

	const saveNewVersion = async () => {
		if (disabled) {
			toast.error('You do not have permission to edit this prompt.');
			return;
		}
		if (!isValidCommand(command)) {
			toast.error('Only alphanumeric characters and hyphens are allowed in the command string.');
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
			toast.error(`${error}`);
		}
		setSaving(false);
	};

	const setAsProduction = async (entry: HistoryEntry) => {
		if (disabled) {
			toast.error('You do not have permission to edit this prompt.');
			return;
		}
		try {
			await setProductionPromptVersion(token, prompt.id, entry.id);
			setVersionId(entry.id);
			toast.success('Production version updated');
		} catch (error) {
			toast.error(`${error}`);
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
			toast.error(`${error}`);
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
							<button
								key={entry.id}
								type="button"
								className={cn(
									'relative w-full px-1.5 py-1.5 pl-3 text-left transition',
									active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
								)}
								onClick={() => setSelected(entry)}
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
										<span className="text-muted-foreground inline-flex shrink-0 items-center text-xs">
											Live
										</span>
									)}
								</div>
								<div className="text-muted-foreground flex items-center gap-1 text-xs">
									{entry.user && (
										<>
											<img
												src={`${WEBUI_API_BASE_URL}/users/${entry.user.id}/profile/image`}
												alt={entry.user.name}
												className="mr-0.5 size-3 rounded-full"
												onError={(e) => {
													e.currentTarget.style.visibility = 'hidden';
												}}
											/>
											<span className="truncate">{entry.user.name}</span>
											<span>•</span>
										</>
									)}
									<span className="shrink-0">{formatSecondsTimestamp(entry.created_at)}</span>
								</div>
							</button>
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
					<div className="text-muted-foreground py-6 text-center text-xs italic">
						No history available
					</div>
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
				onChange={async (grants) => {
					setAccessGrants(grants);
					try {
						await updatePromptAccessGrants(token, prompt.id, grants);
						toast.success('Saved');
					} catch (error) {
						toast.error(`${error}`);
					}
				}}
			/>

			<Dialog open={showEdit} onOpenChange={setShowEdit}>
				<DialogContent className="sm:max-w-2xl">
					<DialogHeader>
						<DialogTitle className="text-xs">Edit Prompt</DialogTitle>
						<DialogDescription className="sr-only">
							Saving creates a new version of this prompt.
						</DialogDescription>
					</DialogHeader>
					<form
						onSubmit={(e) => {
							e.preventDefault();
							saveNewVersion();
						}}
					>
						<div className="my-2">
							<div className="text-muted-foreground text-xs">Prompt Content</div>
							<textarea
								className="mt-1 w-full resize-none bg-transparent text-xs outline-hidden"
								placeholder="Write a summary in 50 words that summarizes {{topic}}."
								aria-label="Prompt Content"
								rows={6}
								required
								value={content}
								onChange={(e) => setContent(e.target.value)}
							/>
						</div>
						<div className="my-2">
							<div className="text-muted-foreground text-xs">Commit Message (optional)</div>
							<input
								className="mt-1 w-full bg-transparent text-xs outline-hidden"
								placeholder="Describe what changed..."
								aria-label="Commit Message"
								value={commitMessage}
								onChange={(e) => setCommitMessage(e.target.value)}
							/>
						</div>
						<div className="mt-4 flex items-center justify-between">
							<label className="flex cursor-pointer items-center gap-2">
								<Checkbox checked={isProduction} onCheckedChange={(c) => setIsProduction(c === true)} />
								<span className="text-xs">Set as Production</span>
							</label>
							<Button type="submit" size="sm" disabled={saving}>
								Save
								{saving && <Spinner className="size-3.5" />}
							</Button>
						</div>
					</form>
				</DialogContent>
			</Dialog>

			<button
				type="button"
				className="text-muted-foreground hover:text-foreground mb-1 flex h-6 w-fit items-center gap-1 rounded-md text-xs transition-colors"
				onClick={() => navigate(routePaths.workspacePrompts)}
			>
				<ChevronLeft className="size-3" strokeWidth={2} />
				<span>Back</span>
			</button>

			<div className="flex shrink-0 items-start justify-between gap-3 pb-1">
				<div className="min-w-0 flex-1">
					<input
						className="w-full bg-transparent text-sm outline-hidden"
						placeholder="Prompt Name"
						aria-label="Prompt Name"
						value={name}
						disabled={disabled}
						onChange={(e) => {
							setName(e.target.value);
							scheduleMetadataSave({ name: e.target.value, command, tags });
						}}
					/>
					<div className="text-muted-foreground mt-0.5 flex min-w-0 items-center gap-2 text-xs">
						<div className="flex min-w-0 flex-1 items-center gap-0.5">
							<span>/</span>
							<input
								className="min-w-0 flex-1 bg-transparent outline-hidden"
								placeholder="command"
								aria-label="Command"
								value={command}
								disabled={disabled}
								onChange={(e) => {
									setCommand(e.target.value);
									scheduleMetadataSave({ name, command: e.target.value, tags });
								}}
							/>
						</div>
					</div>
				</div>

				<div className="flex shrink-0 items-center gap-1.5 pr-0.5">
					{!disabled ? (
						<>
							<Button variant="outline" size="sm" onClick={() => setShowEdit(true)}>
								Edit
							</Button>
							<AccessButton onClick={() => setShowAccess(true)} />
						</>
					) : (
						<span className="bg-muted text-muted-foreground rounded-lg px-2 py-1 text-xs">
							Read Only
						</span>
					)}
				</div>
			</div>

			<div className="mb-1 flex items-center justify-between gap-2">
				<div className="min-w-0 flex-1">
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
					<button
						type="button"
						className="text-muted-foreground hover:text-foreground max-w-56 min-w-0 shrink-0 truncate rounded-md px-1 py-0.5 font-mono text-xs transition"
						onClick={() => {
							copyToClipboard(prompt.id);
							toast.success('ID copied to clipboard');
						}}
					>
						{prompt.id}
					</button>
				</Tip>
			</div>

			<div className="flex flex-1 flex-col gap-3 overflow-hidden pb-4 md:flex-row">
				<div className="hidden w-64 shrink-0 overflow-hidden md:flex md:flex-col">
					<div className="flex-1 overflow-y-auto">{historySection}</div>
				</div>

				<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
					<div className="mb-1 flex shrink-0 items-center justify-between">
						<div className="flex items-center gap-2">
							<div className="text-muted-foreground text-xs">Prompt Content</div>
							{selected && (
								<span className="text-muted-foreground px-1 font-mono text-xs">
									{selected.id.slice(0, 7)}
								</span>
							)}
						</div>
						{selected && !disabled && (
							<div className="flex items-center gap-2">
								{selected.id === versionId ? (
									<span className="text-muted-foreground inline-flex items-center text-xs">Live</span>
								) : (
									<button
										type="button"
										className="text-muted-foreground hover:text-foreground text-xs transition hover:underline"
										onClick={() => setAsProduction(selected)}
									>
										Set as Production
									</button>
								)}
								<PromptHistoryMenu
									isProduction={selected.id === versionId}
									onDelete={() => deleteVersion(selected.id)}
								/>
							</div>
						)}
					</div>
					<div className="relative min-h-0 flex-1">
						<div className="absolute top-2 right-2 z-10">
							<Button variant="ghost" size="icon-sm" aria-label="Copy content" onClick={copyContent}>
								{contentCopied ? <Check className="text-green-500" /> : <Clipboard />}
							</Button>
						</div>
						<div className="bg-muted/40 h-full overflow-y-auto rounded-lg px-3 py-2">
							<pre className="pr-8 font-mono text-[0.6875rem] leading-relaxed whitespace-pre-wrap">
								{shownContent}
							</pre>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
