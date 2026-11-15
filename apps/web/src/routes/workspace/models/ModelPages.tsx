import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { Gone, isNotFound } from '@/components/common/Gone';
import { LoadFailed } from '@/components/common/LoadFailed';
import { Spinner } from '@/components/common/Spinner';
import { Button } from '@/components/ui/button';
import { errorDetail } from '@/lib/apis/errors';
import { createNewModel, getModelById, updateModelById } from '@/lib/apis/models';
import { useAuthStore } from '@/lib/stores/authStore';
import { routePaths } from '@/routes/routePaths';
import { ModelEditor } from './ModelEditor';

type EditorModel = NonNullable<Parameters<typeof ModelEditor>[0]['model']>;

import type { ModelInfo } from './modelEditorLogic';
import { type IncomingModel, sanitizeIncomingModel } from './modelImport';

/** The API helpers answer a failure with null; the editor needs it thrown, to show it above the save bar. */
const orThrow = async <T,>(request: Promise<T | null>): Promise<T> => {
	const res = await request.catch((error) => {
		throw errorDetail(error);
	});
	if (!res) throw new Error('The server did not save it.');
	return res;
};

/**
 * Ports (app)/workspace/models/create/+page.svelte. The form can start from a
 * clone (left in `sessionStorage.model`, read once). The editor refuses an id
 * that already exists, under the ID field.
 */
export function ModelCreatePage() {
	const token = useAuthStore((s) => s.token) ?? '';
	const navigate = useNavigate();
	const queryClient = useQueryClient();

	const [stash] = useState(() => {
		const raw = sessionStorage.model;
		if (!raw) return null;
		sessionStorage.removeItem('model');
		try {
			return sanitizeIncomingModel(JSON.parse(raw), { withGrants: true });
		} catch {
			return null;
		}
	});
	const model: IncomingModel | null = stash;

	const onSubmit = async (info: ModelInfo) => {
		const suggestions = info.meta.suggestion_prompts as Array<{ content: string }> | null;
		await orThrow(
			createNewModel(token, {
				...info,
				meta: {
					...info.meta,
					suggestion_prompts: suggestions ? suggestions.filter((p) => p.content !== '') : null
				},
				params: { ...info.params }
			})
		);
		await queryClient.invalidateQueries({ queryKey: ['models-all'] });
		toast.success(`Created “${info.name}”`);
	};

	return <ModelEditor model={model} onSubmit={onSubmit} onBack={() => navigate(routePaths.workspaceModels)} />;
}

/**
 * Ports (app)/workspace/models/edit/+page.svelte: the model is named by `?id=`.
 * A missing one is said in place (NAV-3), a failed load offers to try again
 * (STA-4), and one this user may only read goes back to the list.
 */
export function ModelEditPage() {
	const token = useAuthStore((s) => s.token) ?? '';
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [params] = useSearchParams();
	const id = params.get('id');

	useEffect(() => {
		if (!id) navigate(routePaths.workspaceModels, { replace: true });
	}, [id, navigate]);

	const loaded = useQuery({
		queryKey: ['model-edit', id],
		enabled: Boolean(id),
		gcTime: 0,
		retry: false,
		queryFn: async () => {
			// The helper throws the response body; its `detail` tells "not found" from a failure.
			const res = await getModelById(token, id as string).catch((error) => {
				throw errorDetail(error);
			});
			if (!res) throw new Error('The server returned no model.');
			return res as EditorModel & { write_access?: boolean };
		}
	});
	const model = loaded.data;

	useEffect(() => {
		if (model && !model.write_access) {
			toast.error(`You can't edit “${model.name}”: it is shared with you to use, not to change.`);
			navigate(routePaths.workspaceModels);
		}
	}, [model, navigate]);

	const onSubmit = async (info: ModelInfo) => {
		await orThrow(updateModelById(token, info.id, info));
		await queryClient.invalidateQueries({ queryKey: ['models-all'] });
		toast.success(`Saved “${info.name}”`);
	};

	if (loaded.isError) {
		return isNotFound(loaded.error) ? (
			<Gone
				level={2}
				title="This model doesn't exist."
				description="It may have been deleted, or the link is wrong."
				actions={<Button onClick={() => navigate(routePaths.workspaceModels)}>Go to Models</Button>}
			/>
		) : (
			<LoadFailed what="the model" error={loaded.error} onRetry={() => loaded.refetch()} retrying={loaded.isFetching} />
		);
	}
	if (!model?.write_access) {
		return (
			<div className="flex h-full items-center justify-center">
				<Spinner />
			</div>
		);
	}
	return (
		<ModelEditor
			key={model.id}
			edit
			model={model}
			onSubmit={onSubmit}
			onBack={() => navigate(routePaths.workspaceModels)}
		/>
	);
}
