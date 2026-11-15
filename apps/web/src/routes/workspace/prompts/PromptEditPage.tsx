import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { Gone, isNotFound } from '@/components/common/Gone';
import { LoadFailed } from '@/components/common/LoadFailed';
import { Spinner } from '@/components/common/Spinner';
import { Button } from '@/components/ui/button';
import { getPromptById, updatePromptById } from '@/lib/apis/prompts';
import { useAuthStore } from '@/lib/stores/authStore';
import { routePaths } from '@/routes/routePaths';
import { PromptEditView } from './PromptEditView';
import { type EditablePrompt, type PromptDraft, toEditablePrompt } from './promptTypes';

/**
 * Ports (app)/workspace/prompts/[id]/+page.svelte: loads the prompt named in
 * the URL, hands it to the editor read-only unless the user has write access,
 * and after each "new version" save adopts the server's returned record so the
 * Live badge and content follow it. A prompt that is not there says so in
 * place (NAV-3); one that failed to load offers to try again (STA-4).
 */
export function PromptEditPage() {
	const { id } = useParams();
	const token = useAuthStore((s) => s.token) ?? '';
	const [prompt, setPrompt] = useState<EditablePrompt | null>(null);
	const [disabled, setDisabled] = useState(false);
	const [failure, setFailure] = useState<{ error: unknown } | null>(null);
	const [attempt, setAttempt] = useState(0);
	const retry = useCallback(() => setAttempt((n) => n + 1), []);

	useEffect(() => {
		if (!id) return;
		let cancelled = false;
		setPrompt(null);
		setFailure(null);
		void attempt;
		getPromptById(token, id).then(
			(res) => {
				if (cancelled) return;
				if (!res) {
					setFailure({ error: undefined });
					return;
				}
				setDisabled(!res.write_access);
				setPrompt(toEditablePrompt(res));
			},
			(error) => {
				if (!cancelled) setFailure({ error });
			}
		);
		return () => {
			cancelled = true;
		};
	}, [id, token, attempt]);

	// A failure throws: the Edit dialog says why, under Command when the command is taken.
	const onSubmit = async (draft: PromptDraft) => {
		const updated = await updatePromptById(token, draft);
		if (updated) {
			toast.success('New version saved');
			setPrompt(toEditablePrompt(updated));
		}
	};

	if (!id) return <Navigate to={routePaths.workspacePrompts} replace />;
	if (failure) {
		return isNotFound(failure.error) ? (
			<Gone
				level={2}
				title="This prompt no longer exists."
				description="It may have been deleted, or the link may be mistyped."
				actions={
					<Button asChild>
						<Link to={routePaths.workspacePrompts}>Prompts</Link>
					</Button>
				}
			/>
		) : (
			<LoadFailed what="this prompt" error={failure.error} onRetry={retry} />
		);
	}
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
