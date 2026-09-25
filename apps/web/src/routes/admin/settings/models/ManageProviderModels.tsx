import { useQueryClient } from '@tanstack/react-query';
import { Download, Play, RefreshCw, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { Spinner } from '@/components/common/Spinner';
import { Tip } from '@/components/common/Tip';
import { deleteProviderModel, downloadProviderModel, getErrorMessage, getProviderModelCatalog, loadProviderModel, unloadProviderModel } from '@/lib/apis/openai';
import { useAuthStore } from '@/lib/stores/authStore';
import { cn } from '@/lib/utils';
import { type ProviderModel, displayNameOf, modelIdOf, normalizeCatalog, statusClass, statusOf, unloadIdOf } from './providerModels';

const inputClass = 'bg-muted/40 placeholder:text-muted-foreground/50 focus:border-ring h-7 w-full rounded-lg border px-2.5 text-left text-xs outline-hidden transition-colors disabled:opacity-50';
const iconButtonClass = 'bg-muted/40 hover:bg-muted inline-flex h-7 items-center justify-center rounded-lg border px-2.5 transition-colors disabled:cursor-not-allowed disabled:opacity-50';

/** Ports admin/Settings/Models/Manage/ManageProviderModels.svelte: download, load, unload and delete models on a llama.cpp or LM Studio connection. */
export function ManageProviderModels({ urlIdx, provider, label, supportsDelete }: { urlIdx: number; provider: string; label: string; supportsDelete: boolean }) {
	const token = useAuthStore((s) => s.token) ?? '';
	const queryClient = useQueryClient();
	const [models, setModels] = useState<ProviderModel[]>([]);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState('');
	const [modelRef, setModelRef] = useState('');
	const [toDelete, setToDelete] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		setLoading(true);
		try {
			setModels(normalizeCatalog(await getProviderModelCatalog(token, urlIdx)));
		} catch (error) {
			toast.error(getErrorMessage(error));
			setModels([]);
		}
		setLoading(false);
	}, [token, urlIdx]);
	useEffect(() => {
		void refresh();
	}, [refresh]);

	/** Runs one provider action, then reloads both this list and the app's model list. */
	const act = async (modelId: string, action: () => Promise<unknown>, success: string) => {
		setBusy(modelId);
		try {
			if (await action()) {
				toast.success(success);
				await refresh();
				await queryClient.invalidateQueries({ queryKey: ['models-all'] });
			}
		} catch (error) {
			toast.error(getErrorMessage(error));
		}
		setBusy('');
	};

	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-center justify-between">
				<div className="text-sm font-normal">{label || provider}</div>
				<Tip content="Refresh">
					<button type="button" aria-label="Refresh" className={iconButtonClass} onClick={() => void refresh()} disabled={loading}>
						<RefreshCw className="size-4" />
					</button>
				</Tip>
			</div>

			<form
				className="flex gap-1.5"
				onSubmit={(e) => {
					e.preventDefault();
					e.stopPropagation();
					const model = modelRef.trim();
					if (!model) return;
					void act(model, () => downloadProviderModel(token, urlIdx, model), 'Model download started').then(() => setModelRef(''));
				}}
			>
				<input className={inputClass} type="text" aria-label="Model ref" placeholder="Type a model ref" autoComplete="off" value={modelRef} onChange={(e) => setModelRef(e.target.value)} />
				<Tip content="Download Model">
					<button type="submit" aria-label="Download Model" className={iconButtonClass} disabled={busy !== '' || modelRef.trim() === ''}>
						<Download className="size-4" />
					</button>
				</Tip>
			</form>

			{loading ? (
				<div className="py-5">
					<Spinner />
				</div>
			) : models.length === 0 ? (
				<div className="text-muted-foreground py-5 text-center text-xs">No models found</div>
			) : (
				<div className="max-h-96 overflow-y-auto rounded-lg border">
					{models.map((model) => {
						const id = modelIdOf(model);
						const name = displayNameOf(model);
						const status = statusOf(model, provider);
						return (
							<div key={id} className="flex items-center justify-between gap-2 border-b px-2 py-2 last:border-b-0">
								<div className="min-w-0 flex-1">
									<div className="truncate text-xs font-medium">{name}</div>
									{name !== id && <div className="text-muted-foreground truncate text-[0.65rem]">{id}</div>}
									<div className="mt-1 flex items-center gap-1.5">
										<span className={cn('rounded-full px-1.5 py-0.5 text-[0.65rem]', statusClass(status))}>{status}</span>
									</div>
								</div>
								<div className="flex shrink-0 gap-1">
									<Tip content="Load Model">
										<button type="button" aria-label={`Load ${name}`} className={iconButtonClass} disabled={busy !== '' || status === 'loaded' || status === 'loading'} onClick={() => void act(id, () => loadProviderModel(token, urlIdx, id), 'Model loaded successfully')}>
											<Play className="size-4" />
										</button>
									</Tip>
									<Tip content="Unload Model">
										<button type="button" aria-label={`Unload ${name}`} className={iconButtonClass} disabled={busy !== '' || status === 'unloaded'} onClick={() => void act(id, () => unloadProviderModel(token, urlIdx, id, unloadIdOf(model)), 'Model unloaded successfully')}>
											<X className="size-4" />
										</button>
									</Tip>
									{supportsDelete && (
										<Tip content="Delete Model">
											<button type="button" aria-label={`Delete ${name}`} className={iconButtonClass} disabled={busy !== ''} onClick={() => setToDelete(id)}>
												<Trash2 className="size-4" />
											</button>
										</Tip>
									)}
								</div>
							</div>
						);
					})}
				</div>
			)}

			<ConfirmDialog
				open={toDelete !== null}
				onOpenChange={(open) => !open && setToDelete(null)}
				title="Delete Model"
				onConfirm={async () => {
					const id = toDelete;
					setToDelete(null);
					if (id) await act(id, () => deleteProviderModel(token, urlIdx, id), 'Model deleted successfully');
				}}
			>
				This will delete the cached model and cannot be undone.
			</ConfirmDialog>
		</div>
	);
}
