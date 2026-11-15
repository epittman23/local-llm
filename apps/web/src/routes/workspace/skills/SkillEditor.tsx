import { ChevronLeft, EyeIcon, PencilLineIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { useNavigate } from 'react-router';
import { AccessButton } from '@/components/common/AccessButton';
import { AccessControlModal } from '@/components/common/AccessControlModal';
import { EditorError, type EditorProblem, saveProblem } from '@/components/common/EditorError';
import { SafeMarkdown } from '@/components/common/SafeMarkdown';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SaveBar } from '@/components/ui/save-bar';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Textarea } from '@/components/ui/textarea';
import { useAccessGrants } from '@/lib/access/useAccessGrants';
import { updateSkillAccessGrants } from '@/lib/apis/skills';
import { useAuthStore } from '@/lib/stores/authStore';
import { useUnsavedChanges } from '@/lib/ui/useUnsavedChanges';
import { slugify } from '@/lib/utils';
import { formatSkillName, parseFrontmatter } from '@/lib/utils/skills';
import { routePaths } from '@/routes/routePaths';
import { useSingleUser } from '@/routes/workspace/workspaceAccess';
import type { SkillDraft } from './skillTypes';

const count = new Intl.NumberFormat('en-US');
/** The instructions' size, and roughly what they cost the model at about four characters a token (CNT-1, WRD-5). */
export function size(text: string): string {
	const tokens = Math.ceil(text.length / 4);
	const chars = `${count.format(text.length)} ${text.length === 1 ? 'character' : 'characters'}`;
	return `${chars}, about ${count.format(tokens)} ${tokens === 1 ? 'token' : 'tokens'}.`;
}

/**
 * Ports workspace/Skills/SkillEditor.svelte (create, clone and edit in one
 * component, as in the original).
 *
 * - Create: the id follows the name (`slugify`) until typed into; typing into
 *   the instructions fills a blank name/description from `---` frontmatter, so
 *   pasting a SKILL.md file fills the form.
 * - Edit: the id is fixed and shown as text; access changes save immediately
 *   (the Access dialog persists on each change), everything else on Save.
 * - Read-only: the instructions render as text and there is no Save.
 * - Saves on request (FRM-3): a SaveBar, and a guard before leaving with
 *   unsaved changes. A clone or import is unsaved until created. `onSubmit`
 *   resolves once stored (a create then returns to the list) and throws when
 *   the server failed; the reason shows above the footer (FBK-1).
 */
export function SkillEditor({
	skill,
	edit = false,
	clone = false,
	disabled = false,
	onSubmit
}: {
	skill: SkillDraft | null;
	edit?: boolean;
	clone?: boolean;
	disabled?: boolean;
	onSubmit: (skill: SkillDraft) => Promise<void>;
}) {
	const token = useAuthStore((s) => s.token) ?? '';
	const user = useAuthStore((s) => s.user);
	const isAdmin = user?.role === 'admin';
	// Access says nothing while this install has one account (S4-D1, WRD-4).
	const singleUser = useSingleUser();
	const navigate = useNavigate();

	const [name, setName] = useState(skill?.name ?? '');
	const [id, setId] = useState(skill?.id ?? '');
	const [description, setDescription] = useState(skill?.description ?? '');
	const [content, setContent] = useState(skill?.content ?? '');
	const skillId = edit ? skill?.id : undefined;
	const [accessGrants, changeAccess] = useAccessGrants(
		skill?.access_grants ?? [],
		skillId ? (grants) => updateSkillAccessGrants(token, skillId, grants) : null
	);
	const [showAccess, setShowAccess] = useState(false);
	const [loading, setLoading] = useState(false);
	// Write or Preview the instructions (#1094); the help line under them is tied to the field.
	const [view, setView] = useState<'write' | 'preview'>('write');
	const instructionsHelp = useId();
	const [problem, setProblem] = useState<EditorProblem | null>(null);
	const problemId = useId();
	// What Discard goes back to and "saved" compares with: the stored skill, or
	// the empty form. A clone or import has nothing stored yet.
	const [saved, setSaved] = useState(() => ({
		name: skill?.name ?? '',
		id: skill?.id ?? '',
		description: skill?.description ?? '',
		content: skill?.content ?? ''
	}));
	const dirty =
		!disabled &&
		((!edit && skill !== null) ||
			name !== saved.name ||
			id !== saved.id ||
			description !== saved.description ||
			content !== saved.content);
	const { dialog: leaveDialog, allowNext } = useUnsavedChanges(dirty);

	const onNameChange = (value: string) => {
		setName(value);
		if (!edit && !clone && value) setId(slugify(value));
	};

	const onContentChange = (value: string) => {
		setContent(value);
		if (edit) return;
		const fm = parseFrontmatter(value);
		if (fm.name && !name) setName(formatSkillName(fm.name));
		if (fm.description && !description) setDescription(fm.description);
	};

	const submit = async () => {
		if (disabled) return;
		setLoading(true);
		setProblem(null);
		// An edit leaves the enabled state and tags out, so the server keeps the
		// stored ones (#227), even when they changed elsewhere since this page
		// loaded (#527). A new skill, clones included, starts active and untagged.
		try {
			const sentId = edit ? id : slugify(id);
			await onSubmit({
				id: sentId,
				name,
				description,
				content,
				...(edit ? {} : { is_active: true, meta: { tags: [] } }),
				access_grants: accessGrants
			});
			setSaved({ name, id: sentId, description, content });
			setId(sentId);
			if (!edit) {
				allowNext();
				navigate(routePaths.workspaceSkills);
			}
		} catch (error) {
			setProblem(saveProblem(error, 'skill'));
		} finally {
			setLoading(false);
		}
	};

	const discard = () => {
		setName(saved.name);
		setId(saved.id);
		setDescription(saved.description);
		setContent(saved.content);
		setProblem(null);
	};

	return (
		<div className="flex h-full w-full min-w-0 flex-col overflow-hidden">
			{leaveDialog}
			<AccessControlModal
				open={showAccess}
				onOpenChange={setShowAccess}
				accessGrants={accessGrants}
				accessRoles={['read', 'write']}
				share={Boolean(user?.permissions?.sharing?.skills) || isAdmin}
				sharePublic={Boolean(user?.permissions?.sharing?.public_skills) || isAdmin}
				shareUsers={(user?.permissions?.access_grants?.allow_users ?? true) || isAdmin}
				onChange={changeAccess}
			/>

			<form
				className="flex h-full min-h-0 min-w-0 flex-col max-sm:overflow-y-auto"
				onSubmit={(e) => {
					e.preventDefault();
					// Required instructions are checked by the field, which only Write shows.
					if (view === 'preview' && !content.trim()) {
						setView('write');
						return;
					}
					submit();
				}}
			>
				<Button
					variant="ghost"
					size="sm"
					className="mb-1 w-fit"
					type="button"
					onClick={() => navigate(routePaths.workspaceSkills)}
				>
					<ChevronLeft className="size-3" strokeWidth={2} />
					<span>Back</span>
				</Button>

				<div className="flex shrink-0 flex-col gap-2 px-1 pb-3 sm:flex-row sm:items-start">
					<div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-2">
						<div className="flex min-w-0 flex-col gap-1.5">
							<Label htmlFor="skill-name">Skill name</Label>
							<Input
								id="skill-name"
								type="text"
								placeholder="e.g. Code Review Guidelines"
								value={name}
								required
								disabled={disabled}
								onChange={(e) => onNameChange(e.target.value)}
							/>
						</div>
						<div className="flex min-w-0 flex-col gap-1.5">
							{edit ? (
								<>
									{/* Fixed once created: shown as text, not a field. */}
									<span className="text-sm leading-none font-medium">Skill ID</span>
									<span className="flex h-9 min-w-0 items-center truncate font-mono text-dense" title={id}>
										{id}
									</span>
								</>
							) : (
								<>
									<Label htmlFor="skill-id">Skill ID</Label>
									<Input
										id="skill-id"
										className="font-mono"
										type="text"
										placeholder="e.g. code-review-guidelines"
										value={id}
										required
										onChange={(e) => setId(e.target.value)}
									/>
								</>
							)}
						</div>
						<div className="flex min-w-0 flex-col gap-1.5 sm:col-span-2">
							<Label htmlFor="skill-description">Skill description</Label>
							<Textarea
								id="skill-description"
								rows={2}
								// Two lines, growing with the text to six, then scrolling (FRM-1).
								className="max-h-40 resize-none"
								placeholder="e.g. Step-by-step instructions for code reviews"
								value={description}
								disabled={disabled}
								onChange={(e) => setDescription(e.target.value)}
							/>
						</div>
					</div>
					{(disabled || !singleUser) && (
						<div className="order-first flex shrink-0 items-center gap-1 self-end sm:order-none sm:mt-6 sm:self-auto pr-0.5">
							{disabled ? (
								<span className="bg-muted text-muted-foreground rounded-lg px-2 py-1 text-xs">Read Only</span>
							) : (
								<AccessButton onClick={() => setShowAccess(true)} />
							)}
						</div>
					)}
				</div>

				<div className="flex shrink-0 flex-wrap items-end justify-between gap-2 px-1 pb-1.5">
					{disabled ? (
						<span className="text-sm leading-none font-medium">Skill instructions</span>
					) : (
						<Label htmlFor="skill-instructions">Skill instructions</Label>
					)}
					{!disabled && (
						<SegmentedControl
							aria-label="Show the instructions as"
							value={view}
							onValueChange={setView}
							options={[
								{ value: 'write', label: 'Write', icon: PencilLineIcon },
								{ value: 'preview', label: 'Preview', icon: EyeIcon }
							]}
						/>
					)}
				</div>
				{/* On a phone the form scrolls, so the editor keeps a usable height. */}
				<div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border-control bg-surface-1 max-sm:min-h-72">
					{disabled ? (
						<div className="h-full overflow-y-auto px-3 py-2">
							<pre className="font-sans text-reading whitespace-pre-wrap">{content}</pre>
						</div>
					) : view === 'write' ? (
						<textarea
							id="skill-instructions"
							className="h-full w-full resize-none bg-transparent px-3 py-2 text-reading placeholder:text-foreground-muted"
							value={content}
							onChange={(e) => onContentChange(e.target.value)}
							placeholder="e.g. Read the diff first, then list risks before style notes."
							aria-describedby={instructionsHelp}
							required
						/>
					) : (
						<div className="h-full overflow-y-auto px-3 py-2" data-testid="skill-preview">
							{content.trim() ? (
								<SafeMarkdown text={content} className="rich-text text-reading" />
							) : (
								<p className="text-foreground-muted">Nothing to preview yet. Write the instructions first.</p>
							)}
						</div>
					)}
				</div>
				{!disabled && (
					<p id={instructionsHelp} className="text-foreground-muted text-dense shrink-0 px-1 pt-1.5">
						Shown to the model when this skill is on. Markdown. {size(content)}
					</p>
				)}

				{problem && <EditorError id={problemId} problem={problem} />}
				{!disabled && (
					<SaveBar
						creating={!edit}
						className="mt-2 shrink-0 pb-2"
						dirty={dirty}
						saving={loading}
						onDiscard={discard}
						saveLabel={edit ? 'Save changes' : 'Create skill'}
					/>
				)}
			</form>
		</div>
	);
}
