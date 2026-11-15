import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { type RefObject, useId, useRef, useState } from 'react';
import { AccessButton } from '@/components/common/AccessButton';
import { AccessControlModal } from '@/components/common/AccessControlModal';
import { EditorError, type EditorProblem } from '@/components/common/EditorError';
import { Spinner } from '@/components/common/Spinner';
import { Tags } from '@/components/common/Tags';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { FieldMessage, fieldProps } from '@/components/ui/field-message';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { getPromptTags } from '@/lib/apis/prompts';
import { useAuthStore } from '@/lib/stores/authStore';
import { useFieldErrors } from '@/lib/ui/useFieldErrors';
import { useUnsavedChanges } from '@/lib/ui/useUnsavedChanges';
import { cn, slugify } from '@/lib/utils';
import { useSingleUser } from '@/routes/workspace/workspaceAccess';
import { commandProblem, INVALID_COMMAND, isValidCommand, type PromptDraft } from './promptTypes';

/**
 * Ports the create half of workspace/Prompts/PromptEditor.svelte, in its
 * modal form -- the only form the app ever renders (Prompts.svelte always
 * passes `modal={true}`; the Svelte component's full-page create layout is
 * unreachable and not ported).
 *
 * The command follows the name (`slugify`) until it is typed into by hand,
 * after which the two are independent. Clone starts from a draft whose command
 * is already set; renaming a clone re-derives it until touched, as before.
 */
export function PromptCreateDialog({
	open,
	draft,
	onSubmit,
	onClose
}: {
	open: boolean;
	draft: PromptDraft | null;
	onSubmit: (prompt: PromptDraft) => Promise<void>;
	onClose: () => void;
}) {
	// Esc, the scrim and × close through the form, which asks first while it holds a draft (FRM-3).
	const requestClose = useRef(onClose);
	return (
		<Dialog open={open} onOpenChange={(next) => !next && requestClose.current()}>
			<DialogContent
				showCloseButton={false}
				// OVL-1: a large form is 48 rem; it opens on its first field, Name.
				className="flex h-[min(54rem,calc(100dvh-4rem))] max-h-[calc(100dvh-4rem)] flex-col gap-0 p-0 sm:max-w-3xl"
				onOpenAutoFocus={(e) => {
					e.preventDefault();
					(e.currentTarget as HTMLElement).querySelector<HTMLElement>('[data-initial-focus]')?.focus();
				}}
			>
				{/* Remounted per open, so the form always starts from the current draft. */}
				{open && (
					<CreateForm
						key={draft ? 'clone' : 'new'}
						draft={draft}
						onSubmit={onSubmit}
						onClose={onClose}
						requestClose={requestClose}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}

function CreateForm({
	draft,
	onSubmit,
	onClose,
	requestClose
}: {
	draft: PromptDraft | null;
	onSubmit: (prompt: PromptDraft) => Promise<void>;
	onClose: () => void;
	requestClose: RefObject<() => void>;
}) {
	const token = useAuthStore((s) => s.token) ?? '';
	const user = useAuthStore((s) => s.user);
	const isAdmin = user?.role === 'admin';

	const [name, setName] = useState(draft?.name ?? '');
	const [command, setCommand] = useState(
		draft?.command.startsWith('/') ? draft.command.slice(1) : (draft?.command ?? '')
	);
	const [manualCommand, setManualCommand] = useState(false);
	const [content, setContent] = useState(draft?.content ?? '');
	const [tags, setTags] = useState<{ name: string }[]>((draft?.tags ?? []).map((n) => ({ name: n })));
	const [accessGrants, setAccessGrants] = useState(draft?.access_grants ?? []);
	const [showAccess, setShowAccess] = useState(false);
	const [loading, setLoading] = useState(false);
	// FRM-2: a bad or taken command is said under Command; anything else above the footer.
	const [commandError, setCommandError] = useState<string | null>(null);
	const [problem, setProblem] = useState<EditorProblem | null>(null);
	const singleUser = useSingleUser();
	const ids = {
		name: useId(),
		nameMsg: useId(),
		command: useId(),
		commandMsg: useId(),
		content: useId(),
		contentMsg: useId(),
		problem: useId()
	};

	// FRM-3: what was typed is a draft; closing it, or leaving the page, asks first.
	const [initial] = useState(() => ({ name, command, content, tags: tags.map((t) => t.name).join('\n') }));
	const dirty =
		name !== initial.name ||
		command !== initial.command ||
		content !== initial.content ||
		tags.map((t) => t.name).join('\n') !== initial.tags;
	const guard = useUnsavedChanges(dirty, {
		message: 'This prompt is not created yet. What you entered is lost if you close it.'
	});
	const close = () => guard.confirmLeave(onClose);
	requestClose.current = close;
	// FRM-2: each field says what is wrong under itself (#1010), never in a browser bubble.
	const {
		errors,
		field,
		submit: checkFields
	} = useFieldErrors(
		{
			name: name.trim() ? undefined : 'Enter a name for this prompt.',
			command: isValidCommand(command) ? undefined : INVALID_COMMAND,
			content: content.trim() ? undefined : 'Write the prompt: its command puts this text in the message.'
		},
		['name', 'command', 'content'] as const
	);
	const commandMessage = errors.command ?? commandError;

	const { data: suggestionTags } = useQuery({
		queryKey: ['prompt-tags'],
		queryFn: () => getPromptTags(token).catch(() => [] as string[])
	});

	const submit = async () => {
		setProblem(null);
		if (!checkFields()) return;
		setCommandError(null);
		setLoading(true);
		try {
			await onSubmit({
				name,
				command,
				content,
				tags: tags.map((t) => t.name),
				access_grants: accessGrants
			});
			// Created: the draft is kept, so closing (and leaving /workspace/prompts/create) does not ask.
			guard.allowNext();
			onClose();
			return;
		} catch (error) {
			const taken = commandProblem(error, command);
			if (taken) setCommandError(taken);
			else setProblem({ message: `Couldn't create the prompt. ${error}`, detail: null });
		}
		setLoading(false);
	};

	return (
		<>
			{guard.dialog}
			<AccessControlModal
				open={showAccess}
				onOpenChange={setShowAccess}
				accessGrants={accessGrants}
				onChange={setAccessGrants}
				accessRoles={['read', 'write']}
				share={Boolean(user?.permissions?.sharing?.prompts) || isAdmin}
				sharePublic={Boolean(user?.permissions?.sharing?.public_prompts) || isAdmin}
				shareUsers={(user?.permissions?.access_grants?.allow_users ?? true) || isAdmin}
			/>

			<div className="flex items-center justify-between px-5 pt-4 pb-2">
				<DialogTitle>New prompt</DialogTitle>
				<DialogDescription className="sr-only">
					Name a prompt, give it a slash command, and write its content.
				</DialogDescription>
				<Button
					variant="ghost"
					size="icon-sm"
					className="ml-2 shrink-0"
					type="button"
					aria-label="Close"
					onClick={close}
				>
					<X className="size-5" />
				</Button>
			</div>

			<form
				className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 pb-3"
				noValidate
				onSubmit={(e) => {
					e.preventDefault();
					submit();
				}}
			>
				<div
					className={cn(
						'grid shrink-0 gap-3 sm:items-start',
						singleUser ? 'sm:grid-cols-2' : 'sm:grid-cols-[1fr_1fr_auto]'
					)}
				>
					<div className="flex min-w-0 flex-col gap-1.5">
						<Label htmlFor={ids.name}>Name</Label>
						<Input
							id={ids.name}
							data-initial-focus
							placeholder="e.g. Summarise a topic"
							value={name}
							{...field('name')}
							{...fieldProps(ids.nameMsg, { error: errors.name })}
							onChange={(e) => {
								setName(e.target.value);
								if (!manualCommand) setCommand(e.target.value !== '' ? slugify(e.target.value) : '');
							}}
						/>
						<FieldMessage id={ids.nameMsg} error={errors.name} />
					</div>
					<div className="flex min-w-0 flex-col gap-1.5">
						<Label htmlFor={ids.command}>Command</Label>
						<CommandField
							id={ids.command}
							value={command}
							{...fieldProps(ids.commandMsg, { error: commandMessage, help: true })}
							{...field('command')}
							onChange={(value) => {
								setManualCommand(true);
								setCommand(value);
								setCommandError(null);
							}}
						/>
						<FieldMessage
							id={ids.commandMsg}
							error={commandMessage}
							help={command ? `Type /${command} in a chat to use it.` : 'Letters, numbers, hyphens and underscores.'}
						/>
					</div>
					{!singleUser && (
						<div className="sm:mt-6">
							<AccessButton onClick={() => setShowAccess(true)} />
						</div>
					)}
				</div>
				<div className="shrink-0">
					<Tags
						tags={tags}
						suggestionTags={suggestionTags ?? []}
						onAdd={(n) => setTags((prev) => [...prev, { name: n }])}
						onDelete={(n) => setTags((prev) => prev.filter((t) => t.name !== n))}
					/>
				</div>

				<div className="flex min-h-48 flex-1 flex-col gap-1.5">
					<Label htmlFor={ids.content}>Prompt content</Label>
					<Textarea
						id={ids.content}
						className="min-h-0 flex-1 resize-none"
						placeholder="e.g. Summarise {{topic}} in 50 words."
						value={content}
						{...field('content')}
						{...fieldProps(ids.contentMsg, { error: errors.content, help: true })}
						onChange={(e) => setContent(e.target.value)}
					/>
					<FieldMessage
						id={ids.contentMsg}
						error={errors.content}
						help={<>Use {'{{variable}}'} for a placeholder you fill in when you use it.</>}
					/>
				</div>

				{problem && <EditorError id={ids.problem} problem={problem} />}
				<div className="flex shrink-0 justify-end gap-2 pt-1">
					<Button type="button" variant="ghost" onClick={close}>
						Cancel
					</Button>
					<Button type="submit" disabled={loading} aria-busy={loading || undefined}>
						{loading && <Spinner className="size-3.5" />}
						Create prompt
					</Button>
				</div>
			</form>
		</>
	);
}

/**
 * The slash command as one field (FRM-1, A11Y-1): the box draws the edge, the
 * fill and the focus around a fixed "/" and the bare input after it.
 */
export function CommandField({
	id,
	value,
	disabled,
	onChange,
	...rest
}: {
	id: string;
	value: string;
	disabled?: boolean;
	onChange: (value: string) => void;
	'aria-describedby'?: string;
	'aria-invalid'?: true;
	ref?: (element: HTMLElement | null) => void;
	onBlur?: () => void;
}) {
	return (
		<div
			data-composite-field
			className="border-border-control bg-surface-1 flex h-(--control) min-w-0 items-center gap-0.5 rounded-lg border ps-3 pe-1 has-[:disabled]:text-foreground-disabled has-[[aria-invalid]]:border-danger pointer-coarse:h-(--control-touch)"
		>
			<span aria-hidden className="text-foreground-muted font-mono">
				/
			</span>
			<input
				id={id}
				className="text-body h-full w-full min-w-0 bg-transparent font-mono"
				placeholder="summarise"
				value={value}
				disabled={disabled}
				autoComplete="off"
				spellCheck={false}
				onChange={(e) => onChange(e.target.value)}
				{...rest}
			/>
		</div>
	);
}
