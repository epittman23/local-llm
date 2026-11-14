import { ChevronLeft } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { AccessButton } from '@/components/common/AccessButton';
import { AccessControlModal } from '@/components/common/AccessControlModal';
import { Spinner } from '@/components/common/Spinner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAccessGrants } from '@/lib/access/useAccessGrants';
import { updateSkillAccessGrants } from '@/lib/apis/skills';
import { useAuthStore } from '@/lib/stores/authStore';
import { slugify } from '@/lib/utils';
import { formatSkillName, parseFrontmatter } from '@/lib/utils/skills';
import { routePaths } from '@/routes/routePaths';
import type { SkillDraft } from './skillTypes';

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
		if (disabled) {
			toast.error('You do not have permission to edit this skill.');
			return;
		}
		setLoading(true);
		// An edit leaves the enabled state and tags out, so the server keeps the
		// stored ones (#227), even when they changed elsewhere since this page
		// loaded (#527). A new skill, clones included, starts active and untagged.
		try {
			await onSubmit({
				id: edit ? id : slugify(id),
				name,
				description,
				content,
				...(edit ? {} : { is_active: true, meta: { tags: [] } }),
				access_grants: accessGrants
			});
		} finally {
			setLoading(false);
		}
	};

	return (
		<div className="flex h-full w-full min-w-0 flex-col overflow-hidden">
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
				className="flex h-full min-h-0 min-w-0 flex-col"
				onSubmit={(e) => {
					e.preventDefault();
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
							<Input
								id="skill-description"
								type="text"
								placeholder="e.g. Step-by-step instructions for code reviews"
								value={description}
								disabled={disabled}
								onChange={(e) => setDescription(e.target.value)}
							/>
						</div>
					</div>
					<div className="order-first flex shrink-0 items-center gap-1 self-end sm:order-none sm:mt-6 sm:self-auto pr-0.5">
						{!disabled ? (
							<AccessButton onClick={() => setShowAccess(true)} />
						) : (
							<span className="bg-muted text-muted-foreground rounded-lg px-2 py-1 text-xs">Read Only</span>
						)}
					</div>
				</div>

				{disabled ? (
					<span className="px-1 pb-1.5 text-sm leading-none font-medium">Skill instructions</span>
				) : (
					<Label htmlFor="skill-instructions" className="px-1 pb-1.5">
						Skill instructions
					</Label>
				)}
				<div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border-control bg-surface-1">
					{disabled ? (
						<div className="h-full overflow-y-auto px-3 py-2">
							<pre className="font-mono text-caption leading-relaxed whitespace-pre-wrap">{content}</pre>
						</div>
					) : (
						<textarea
							id="skill-instructions"
							className="h-full w-full resize-none bg-transparent px-3 py-2 font-mono text-caption leading-relaxed placeholder:text-foreground-muted"
							value={content}
							onChange={(e) => onContentChange(e.target.value)}
							placeholder="e.g. Read the diff first, then list risks before style notes. Markdown is fine."
							required
						/>
					)}
				</div>

				{!disabled && (
					<div className="flex shrink-0 justify-end py-2">
						<Button type="submit" size="sm" disabled={loading}>
							{edit ? 'Save' : 'Save & Create'}
							{loading && <Spinner className="size-3" />}
						</Button>
					</div>
				)}
			</form>
		</div>
	);
}
