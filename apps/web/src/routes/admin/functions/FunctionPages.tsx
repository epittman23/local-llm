import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { Spinner } from '@/components/common/Spinner';
import { createNewFunction, getFunctionById, updateFunctionById } from '@/lib/apis/functions';
import { useAuthStore } from '@/lib/stores/authStore';
import { refusedForVersion } from '@/lib/utils/pluginVersion';
import { routePaths } from '@/routes/routePaths';
import { FunctionEditor } from './FunctionEditor';
import { type FunctionDraft, sanitizeIncomingFunction } from './functionTypes';

// The create/update endpoints take exactly these four fields.
const payload = (f: FunctionDraft) => ({ id: f.id, name: f.name, meta: f.meta, content: f.content });

/** Functions feed the model list; those consumers (chat, the model pickers) refetch when these keys go stale. */
const useRefreshFunctions = () => {
	const queryClient = useQueryClient();
	return () =>
		Promise.all([
			queryClient.invalidateQueries({ queryKey: ['functions'] }),
			queryClient.invalidateQueries({ queryKey: ['models'] })
		]);
};

/**
 * Ports (app)/admin/functions/create/+page.svelte. The form can be pre-filled
 * from a clone or link import (left in `sessionStorage.function`, read once),
 * sanitized to the four editable fields.
 */
export function FunctionCreatePage() {
	const token = useAuthStore((s) => s.token) ?? '';
	const navigate = useNavigate();
	const refresh = useRefreshFunctions();
	const [stash] = useState(() => {
		const raw = sessionStorage.function;
		if (!raw) return null;
		sessionStorage.removeItem('function');
		try {
			return sanitizeIncomingFunction(JSON.parse(raw));
		} catch {
			return null;
		}
	});
	const fn: FunctionDraft | null = stash;

	const onSave = async (data: FunctionDraft) => {
		if (refusedForVersion(data.content)) return;
		const res = await createNewFunction(token, payload(data)).catch((error) => {
			toast.error(`${error}`);
			return null;
		});
		if (res) {
			toast.success('Function created successfully');
			await refresh();
			navigate(routePaths.adminFunctions);
		}
	};

	return (
		<div className="h-full min-w-0 overflow-x-hidden px-4">
			<FunctionEditor fn={fn} clone={stash !== null} onSave={onSave} />
		</div>
	);
}

/** Ports (app)/admin/functions/edit/+page.svelte: the function is named by `?id=`; an unknown one bounces to the list. */
export function FunctionEditPage() {
	const token = useAuthStore((s) => s.token) ?? '';
	const navigate = useNavigate();
	const refresh = useRefreshFunctions();
	const [params] = useSearchParams();
	const id = params.get('id');
	const [fn, setFn] = useState<FunctionDraft | null>(null);

	useEffect(() => {
		if (!id) {
			navigate(routePaths.adminFunctions, { replace: true });
			return;
		}
		let cancelled = false;
		setFn(null);
		getFunctionById(token, id)
			.catch((error) => {
				toast.error(`${error}`);
				return null;
			})
			.then((res) => {
				if (cancelled) return;
				if (!res) {
					navigate(routePaths.adminFunctions);
					return;
				}
				setFn({ id: res.id, name: res.name, meta: res.meta ?? { description: '' }, content: res.content ?? '' });
			});
		return () => {
			cancelled = true;
		};
	}, [id, token, navigate]);

	const onSave = async (data: FunctionDraft) => {
		if (!fn || refusedForVersion(data.content)) return;
		const res = await updateFunctionById(token, fn.id, payload(data)).catch((error) => {
			toast.error(`${error}`);
			return null;
		});
		if (res) {
			toast.success('Function updated successfully');
			await refresh();
		}
	};

	if (!fn) {
		return (
			<div className="flex h-full items-center justify-center pb-16">
				<Spinner />
			</div>
		);
	}
	return (
		<div className="h-full min-w-0 overflow-x-hidden px-4">
			<FunctionEditor key={fn.id} fn={fn} edit onSave={onSave} />
		</div>
	);
}
