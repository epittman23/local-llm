import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { Spinner } from '@/components/common/Spinner';
import { createNewModel, getModelById, updateModelById } from '@/lib/apis/models';
import { getModels } from '@/lib/apis';
import { useAuthStore } from '@/lib/stores/authStore';
import { routePaths } from '@/routes/routePaths';
import { ModelEditor } from './ModelEditor';
import { DEFAULT_PROFILE_IMAGE, type ModelInfo } from './modelEditorLogic';
import { type IncomingModel, sanitizeIncomingModel } from './modelImport';

const COMMUNITY_ORIGINS = ['https://openwebui.com', 'https://www.openwebui.com', 'http://localhost:9999'];

/**
 * Ports (app)/workspace/models/create/+page.svelte. The form can start from a
 * clone (left in `sessionStorage.model`, read once) or from a model posted by the
 * community site -- sanitized, never carrying grants -- in which case the editor
 * is remounted with it. Saving refuses an id that already exists.
 */
export function ModelCreatePage() {
	const token = useAuthStore((s) => s.token) ?? '';
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const existing = useQuery({ queryKey: ['models-all'], queryFn: async () => ((await getModels(token)) ?? []) as Array<{ id: string }> });

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
	const [model, setModel] = useState<IncomingModel | null>(stash);
	const [revision, setRevision] = useState(0);

	useEffect(() => {
		const onMessage = (event: MessageEvent) => {
			if (!COMMUNITY_ORIGINS.includes(event.origin)) return;
			try {
				const incoming = sanitizeIncomingModel(JSON.parse(event.data), { withGrants: false });
				if (!incoming) return;
				setModel(incoming);
				setRevision((r) => r + 1);
			} catch (error) {
				console.error('Failed to parse message data:', error);
			}
		};
		window.addEventListener('message', onMessage);
		// A fixed string with no data in it, so '*' discloses nothing.
		if (window.opener) window.opener.postMessage('loaded', '*');
		return () => window.removeEventListener('message', onMessage);
	}, []);

	const onSubmit = async (info: ModelInfo) => {
		if ((existing.data ?? []).some((m) => m.id === info.id)) {
			toast.error(`Error: A model with the ID '${info.id}' already exists. Please select a different ID to proceed.`);
			return;
		}
		if (info.id === '') {
			toast.error('Error: Model ID cannot be empty. Please enter a valid ID to proceed.');
			return;
		}
		const suggestions = info.meta.suggestion_prompts as Array<{ content: string }> | null;
		const res = await createNewModel(token, {
			...info,
			meta: {
				...info.meta,
				// LICENSE covers this Open WebUI fallback logo.
				// Do not alter, remove, obscure, or replace it except as LICENSE permits:
				// https://docs.openwebui.com/license.
				profile_image_url: info.meta.profile_image_url ?? DEFAULT_PROFILE_IMAGE,
				suggestion_prompts: suggestions ? suggestions.filter((p) => p.content !== '') : null
			},
			params: { ...info.params }
		}).catch((error) => {
			toast.error(`${error}`);
			return null;
		});
		if (res) {
			await queryClient.invalidateQueries({ queryKey: ['models-all'] });
			toast.success('Model created successfully!');
			navigate(routePaths.workspaceModels);
		}
	};

	return <ModelEditor key={revision} model={model} onSubmit={onSubmit} onBack={() => navigate(routePaths.workspaceModels)} />;
}

/** Ports (app)/workspace/models/edit/+page.svelte: the model is named by `?id=`; read-only or missing ones bounce back to the list. */
export function ModelEditPage() {
	const token = useAuthStore((s) => s.token) ?? '';
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [params] = useSearchParams();
	const id = params.get('id');
	const [model, setModel] = useState<(Record<string, any> & { id: string; name: string }) | null>(null);

	useEffect(() => {
		if (!id) {
			navigate(routePaths.workspaceModels, { replace: true });
			return;
		}
		let cancelled = false;
		setModel(null);
		getModelById(token, id)
			.catch(() => null)
			.then((res) => {
				if (cancelled) return;
				if (!res) {
					navigate(routePaths.workspaceModels);
					return;
				}
				if (!res.write_access) {
					toast.error('You do not have permission to edit this model');
					navigate(routePaths.workspaceModels);
					return;
				}
				setModel(res);
			});
		return () => {
			cancelled = true;
		};
	}, [id, token, navigate]);

	const onSubmit = async (info: ModelInfo) => {
		const res = await updateModelById(token, info.id, info).catch((error) => {
			toast.error(`${error}`);
			return null;
		});
		if (res) {
			await queryClient.invalidateQueries({ queryKey: ['models-all'] });
			toast.success('Model updated successfully');
			navigate(routePaths.workspaceModels);
		}
	};

	if (!model) {
		return (
			<div className="flex h-full items-center justify-center">
				<Spinner />
			</div>
		);
	}
	return <ModelEditor key={model.id} edit model={model} onSubmit={onSubmit} onBack={() => navigate(routePaths.workspaceModels)} />;
}
