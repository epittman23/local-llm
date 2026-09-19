import { ChevronLeft } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { AccessButton } from '@/components/common/AccessButton';
import { AccessControlModal } from '@/components/common/AccessControlModal';
import { Spinner } from '@/components/common/Spinner';
import { Tip } from '@/components/common/Tip';
import { Button } from '@/components/ui/button';
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
	const [accessGrants, setAccessGrants] = useState(skill?.access_grants ?? []);
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
		try {
			await onSubmit({
				id: edit ? id : slugify(id),
				name,
				description,
				content,
				is_active: true,
				meta: { tags: [] },
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
				onChange={async (grants) => {
					setAccessGrants(grants);
					if (edit && skill?.id) {
						try {
							await updateSkillAccessGrants(token, skill.id, grants);
							toast.success('Saved');
						} catch (error) {
							toast.error(`${error}`);
						}
					}
				}}
			/>

			<form
				className="flex h-full min-h-0 min-w-0 flex-col"
				onSubmit={(e) => {
					e.preventDefault();
					submit();
				}}
			>
				<button
					type="button"
					className="text-muted-foreground hover:text-foreground mb-1 flex h-6 w-fit items-center gap-1 rounded-md text-xs transition-colors"
					onClick={() => navigate(routePaths.workspaceSkills)}
				>
					<ChevronLeft className="size-3" strokeWidth={2} />
					<span>Back</span>
				</button>

				<div className="flex shrink-0 items-start gap-2 px-1 pb-2">
					<div className="min-w-0 flex-1">
						<Tip content="e.g. Code Review Guidelines" side="top">
							<input
								className="w-full bg-transparent text-sm outline-hidden"
								type="text"
								placeholder="Skill Name"
								aria-label="Skill Name"
								value={name}
								required
								disabled={disabled}
								onChange={(e) => onNameChange(e.target.value)}
							/>
						</Tip>
						<div className="text-muted-foreground mt-0.5 flex min-w-0 items-center gap-2 text-xs">
							{edit ? (
								<div className="shrink-0 truncate font-mono" title={id}>
									{id}
								</div>
							) : (
								<Tip content="e.g. code-review-guidelines" side="top">
									<input
										className="min-w-32 flex-1 bg-transparent font-mono outline-hidden"
										type="text"
										placeholder="Skill ID"
										aria-label="Skill ID"
										value={id}
										required
										onChange={(e) => setId(e.target.value)}
									/>
								</Tip>
							)}
							<Tip content="e.g. Step-by-step instructions for code reviews" side="top">
								<input
									className="min-w-0 flex-1 bg-transparent outline-hidden"
									type="text"
									placeholder="Skill Description"
									aria-label="Skill Description"
									value={description}
									disabled={disabled}
									onChange={(e) => setDescription(e.target.value)}
								/>
							</Tip>
						</div>
					</div>
					<div className="flex shrink-0 items-center gap-1 pr-0.5">
						{!disabled ? (
							<AccessButton onClick={() => setShowAccess(true)} />
						) : (
							<span className="bg-muted text-muted-foreground rounded-lg px-2 py-1 text-xs">Read Only</span>
						)}
					</div>
				</div>

				<div className="bg-muted/40 min-h-0 flex-1 overflow-hidden rounded-lg">
					{disabled ? (
						<div className="h-full overflow-y-auto px-3 py-2">
							<pre className="font-mono text-[0.6875rem] leading-relaxed whitespace-pre-wrap">{content}</pre>
						</div>
					) : (
						<textarea
							className="placeholder:text-muted-foreground h-full w-full resize-none bg-transparent px-3 py-2 font-mono text-[0.6875rem] leading-relaxed outline-hidden"
							value={content}
							onChange={(e) => onContentChange(e.target.value)}
							placeholder="Enter skill instructions in markdown..."
							aria-label="Skill Instructions"
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
