import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { Spinner } from '@/components/common/Spinner';
import { createNewSkill, getSkillById, updateSkillById } from '@/lib/apis/skills';
import { useAuthStore } from '@/lib/stores/authStore';
import { routePaths } from '@/routes/routePaths';
import { SkillEditor } from './SkillEditor';
import { type SkillDraft, sanitizeStashedSkill, toSkillDraft } from './skillTypes';

/**
 * Ports (app)/workspace/skills/create/+page.svelte. A skill left in
 * `sessionStorage.skill` by Clone or by a markdown import pre-fills the form
 * (and is consumed -- read once, then removed).
 */
export function SkillCreatePage() {
	const token = useAuthStore((s) => s.token) ?? '';
	const [stash] = useState(() => {
		const raw = sessionStorage.skill;
		if (!raw) return null;
		sessionStorage.removeItem('skill');
		try {
			return sanitizeStashedSkill(JSON.parse(raw));
		} catch {
			return null;
		}
	});

	// The editor returns to the list once created; a failure throws, and the editor says why.
	const onSubmit = async (skill: SkillDraft) => {
		await createNewSkill(token, skill);
		toast.success('Skill created');
	};

	return <SkillEditor skill={stash} clone={stash !== null} onSubmit={onSubmit} />;
}

/** Ports (app)/workspace/skills/edit/+page.svelte: the skill is named by `?id=`. */
export function SkillEditPage() {
	const token = useAuthStore((s) => s.token) ?? '';
	const navigate = useNavigate();
	const [params] = useSearchParams();
	const skillId = params.get('id');
	const [skill, setSkill] = useState<SkillDraft | null>(null);
	const [disabled, setDisabled] = useState(false);

	useEffect(() => {
		if (!skillId) {
			navigate(routePaths.workspaceSkills, { replace: true });
			return;
		}
		let cancelled = false;
		setSkill(null);
		getSkillById(token, skillId)
			.catch((error) => {
				toast.error(`${error}`);
				return null;
			})
			.then((res) => {
				if (cancelled) return;
				if (!res) {
					navigate(routePaths.workspaceSkills);
					return;
				}
				setDisabled(!res.write_access);
				setSkill(toSkillDraft(res));
			});
		return () => {
			cancelled = true;
		};
	}, [skillId, token, navigate]);

	const onSubmit = async (draft: SkillDraft) => {
		if (!skillId) return;
		await updateSkillById(token, skillId, draft);
		toast.success('Skill saved');
	};

	if (!skill) {
		return (
			<div className="flex h-full items-center justify-center">
				<Spinner />
			</div>
		);
	}
	return <SkillEditor key={skill.id} skill={skill} edit disabled={disabled} onSubmit={onSubmit} />;
}
