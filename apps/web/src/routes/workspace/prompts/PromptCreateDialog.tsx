import { X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { AccessButton } from '@/components/common/AccessButton';
import { AccessControlModal } from '@/components/common/AccessControlModal';
import { Spinner } from '@/components/common/Spinner';
import { Tags } from '@/components/common/Tags';
import { Tip } from '@/components/common/Tip';
import { Button } from '@/components/ui/button';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle
} from '@/components/ui/dialog';
import { getPromptTags } from '@/lib/apis/prompts';
import { useAuthStore } from '@/lib/stores/authStore';
import { slugify } from '@/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { type PromptDraft, isValidCommand } from './promptTypes';

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
	return (
		<Dialog open={open} onOpenChange={(next) => !next && onClose()}>
			<DialogContent
				showCloseButton={false}
				className="flex h-[min(54rem,calc(100dvh-4rem))] max-h-[calc(100dvh-4rem)] flex-col gap-0 p-0 sm:max-w-5xl"
			>
				{/* Remounted per open, so the form always starts from the current draft. */}
				{open && <CreateForm key={draft ? 'clone' : 'new'} draft={draft} onSubmit={onSubmit} onClose={onClose} />}
			</DialogContent>
		</Dialog>
	);
}

function CreateForm({
	draft,
	onSubmit,
	onClose
}: {
	draft: PromptDraft | null;
	onSubmit: (prompt: PromptDraft) => Promise<void>;
	onClose: () => void;
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

	const { data: suggestionTags } = useQuery({
		queryKey: ['prompt-tags'],
		queryFn: () => getPromptTags(token).catch(() => [] as string[])
	});

	const submit = async () => {
		if (!isValidCommand(command)) {
			toast.error('Only alphanumeric characters and hyphens are allowed in the command string.');
			return;
		}
		setLoading(true);
		try {
			await onSubmit({
				name,
				command,
				content,
				tags: tags.map((t) => t.name),
				access_grants: accessGrants
			});
		} catch (error) {
			toast.error(`${error}`);
		}
		setLoading(false);
	};

	return (
		<>
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
				<DialogTitle className="text-sm">Create Prompt</DialogTitle>
				<DialogDescription className="sr-only">
					Name a prompt, give it a slash command, and write its content.
				</DialogDescription>
				<button type="button" aria-label="Close" className="ml-2 shrink-0" onClick={onClose}>
					<X className="size-5" />
				</button>
			</div>

			<form
				className="flex min-h-0 flex-1 flex-col px-5 pb-3"
				onSubmit={(e) => {
					e.preventDefault();
					submit();
				}}
			>
				<div className="mb-2 shrink-0">
					<Tip
						side="bottom"
						content={`Only alphanumeric characters and hyphens are allowed - Activate this command by typing "/${command}" to chat input.`}
					>
						<div className="flex w-full flex-col">
							<div className="flex items-center">
								<input
									className="w-full bg-transparent text-sm outline-hidden"
									placeholder="Name"
									aria-label="Name"
									value={name}
									required
									onChange={(e) => {
										setName(e.target.value);
										if (!manualCommand) setCommand(e.target.value !== '' ? slugify(e.target.value) : '');
									}}
								/>
								<div className="shrink-0 self-center">
									<AccessButton onClick={() => setShowAccess(true)} />
								</div>
							</div>
							<div className="text-muted-foreground flex items-center gap-0.5 text-xs">
								<div>/</div>
								<input
									className="w-full bg-transparent outline-hidden"
									placeholder="Command"
									aria-label="Command"
									value={command}
									required
									onChange={(e) => {
										setManualCommand(true);
										setCommand(e.target.value);
									}}
								/>
							</div>
						</div>
					</Tip>
					<div className="mt-1">
						<Tags
							tags={tags}
							suggestionTags={suggestionTags ?? []}
							onAdd={(n) => setTags((prev) => [...prev, { name: n }])}
							onDelete={(n) => setTags((prev) => prev.filter((t) => t.name !== n))}
						/>
					</div>
				</div>

				<div className="my-2 flex min-h-0 flex-1 flex-col">
					<div className="text-muted-foreground text-xs">Prompt Content</div>
					<div className="mt-1 flex min-h-0 flex-1 flex-col">
						<textarea
							className="min-h-0 w-full flex-1 resize-none bg-transparent text-xs outline-hidden"
							placeholder="Write a summary in 50 words that summarizes {{topic}}."
							aria-label="Prompt Content"
							value={content}
							required
							onChange={(e) => setContent(e.target.value)}
						/>
						<div className="text-muted-foreground text-xs">
							ⓘ Use <span className="text-foreground font-normal">{'{{variable}}'}</span> for placeholders
						</div>
					</div>
				</div>

				<div className="flex shrink-0 justify-end gap-2 pt-3">
					<Button type="button" variant="ghost" size="sm" onClick={onClose}>
						Cancel
					</Button>
					<Button type="submit" size="sm" disabled={loading}>
						Save &amp; Create
						{loading && <Spinner className="size-3.5" />}
					</Button>
				</div>
			</form>
		</>
	);
}
