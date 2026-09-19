import { useEffect, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { Spinner } from '@/components/common/Spinner';
import { getPromptById, updatePromptById } from '@/lib/apis/prompts';
import { useAuthStore } from '@/lib/stores/authStore';
import { routePaths } from '@/routes/routePaths';
import { PromptEditView } from './PromptEditView';
import { type EditablePrompt, type PromptDraft, toEditablePrompt } from './promptTypes';

/**
 * Ports (app)/workspace/prompts/[id]/+page.svelte: loads the prompt named in
 * the URL, hands it to the editor read-only unless the user has write access,
 * and after each "new version" save adopts the server's returned record so the
 * Live badge and content follow it. A prompt that fails to load sends the user
 * back to the list.
 */
export function PromptEditPage() {
	const { id } = useParams();
	const token = useAuthStore((s) => s.token) ?? '';
	const navigate = useNavigate();
	const [prompt, setPrompt] = useState<EditablePrompt | null>(null);
	const [disabled, setDisabled] = useState(false);

	useEffect(() => {
		if (!id) return;
		let cancelled = false;
		setPrompt(null);
		getPromptById(token, id)
			.catch((error) => {
				toast.error(`${error}`);
				return null;
			})
			.then((res) => {
				if (cancelled) return;
				if (!res) {
					navigate(routePaths.workspacePrompts);
					return;
				}
				setDisabled(!res.write_access);
				setPrompt(toEditablePrompt(res));
			});
		return () => {
			cancelled = true;
		};
	}, [id, token, navigate]);

	const onSubmit = async (draft: PromptDraft) => {
		const updated = await updatePromptById(token, draft).catch((error) => {
			toast.error(`${error}`);
			return null;
		});
		if (updated) {
			toast.success('Prompt updated successfully');
			setPrompt(toEditablePrompt(updated));
		}
	};

	if (!id) return <Navigate to={routePaths.workspacePrompts} replace />;
	if (!prompt) {
		return (
			<div className="flex h-full items-center justify-center">
				<Spinner />
			</div>
		);
	}
	// Keyed by prompt id so navigating between prompts remounts the editor with fresh state.
	return <PromptEditView key={prompt.id} prompt={prompt} disabled={disabled} onSubmit={onSubmit} />;
}
