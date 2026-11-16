import { useQuery } from '@tanstack/react-query';
import { Minus, Pencil, Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AccessControl } from '@/components/common/AccessControl';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { Spinner } from '@/components/common/Spinner';
import { ProfileAvatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ImageButton } from '@/components/ui/image-button';
import { getModels } from '@/lib/apis';
import { WEBUI_BASE_URL } from '@/lib/constants';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfirmLeave } from '@/lib/ui/useUnsavedChanges';
import { ACCEPTED_IMAGE_TYPES, resizeToDataUrl } from '@/lib/utils/image';
import { type ArenaModel, arenaIdFromName, buildArenaModel } from './arenaModels';

// The stored value that means "no picture of its own"; the avatar draws the initials for it.
const FALLBACK_IMAGE = `${WEBUI_BASE_URL}/favicon.png`;

type ModelInfo = { id: string; name: string; owned_by?: string };

/**
 * Ports Evaluations/ArenaModelModal.svelte: add or edit an "arena model" -- a
 * named alias the arena picks between, optionally limited to (or excluding) a
 * chosen set of real models, with its own picture and access grants.
 *
 * Unlike the Svelte modal (one mounted instance whose fields keep the last
 * values typed), every open starts from the model being edited, or blank.
 */
export function ArenaModelModal({
	open,
	onOpenChange,
	edit = false,
	model = null,
	onSubmit,
	onDelete
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	edit?: boolean;
	model?: ArenaModel | null;
	onSubmit: (model: ArenaModel) => void | Promise<void>;
	onDelete?: () => void | Promise<void>;
}) {
	const token = useAuthStore((s) => s.token) ?? '';
	const models = useQuery({
		queryKey: ['models-all'],
		queryFn: async () => ((await getModels(token)) ?? []) as ModelInfo[],
		enabled: open
	});
	const [name, setName] = useState('');
	const [id, setId] = useState('');
	const [profileImageUrl, setProfileImageUrl] = useState(FALLBACK_IMAGE);
	const [description, setDescription] = useState('');
	const [modelIds, setModelIds] = useState<string[]>([]);
	const [selectedModelId, setSelectedModelId] = useState('');
	const [filterMode, setFilterMode] = useState<'include' | 'exclude'>('include');
	const [accessGrants, setAccessGrants] = useState<unknown[]>([]);
	const [loading, setLoading] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const imageInput = useRef<HTMLInputElement>(null);
	// FRM-3: what the dialog opened with; Escape, the scrim and × ask before losing a change to it.
	const [initial, setInitial] = useState<string | null>(null);
	const draft = JSON.stringify({ name, id, profileImageUrl, description, modelIds, filterMode, accessGrants });
	const dirty = open && initial !== null && (draft !== initial || selectedModelId !== '');
	const guard = useConfirmLeave(dirty, {
		message: edit
			? 'The changes to this arena model are not saved. They are lost if you close it.'
			: 'This arena model is not added yet. What you entered is lost if you close it.'
	});
	const close = () => guard.confirmLeave(() => onOpenChange(false));

	useEffect(() => {
		if (!open) {
			setInitial(null);
			return;
		}
		const start = {
			name: model?.name ?? '',
			id: model?.id ?? '',
			profileImageUrl: model?.meta?.profile_image_url ?? FALLBACK_IMAGE,
			description: model?.meta?.description ?? '',
			modelIds: [...new Set(model?.meta?.model_ids ?? [])],
			filterMode: model?.meta?.filter_mode ?? 'include',
			accessGrants: model?.meta?.access_grants ?? []
		};
		setName(start.name);
		setId(start.id);
		setProfileImageUrl(start.profileImageUrl);
		setDescription(start.description);
		setModelIds(start.modelIds);
		setSelectedModelId('');
		setFilterMode(start.filterMode);
		setAccessGrants(start.accessGrants);
		setInitial(JSON.stringify(start));
		// Seeded when the dialog opens; edits inside it are local.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	const known = models.data ?? [];
	const changeName = (value: string) => {
		setName(value);
		if (!edit && value) setId(arenaIdFromName(value));
	};

	const pickImage = async (files: FileList | null) => {
		const file = files?.[0];
		if (!file || !ACCEPTED_IMAGE_TYPES.includes(file.type)) return;
		try {
			setProfileImageUrl(await resizeToDataUrl(file));
		} catch (error) {
			toast.error(`${error}`);
		}
	};

	const submit = async () => {
		if (!name || !id) {
			toast.error('Name and ID are required, please fill them out');
			return;
		}
		if (!edit && known.some((m) => m.name === name)) {
			setName('');
			toast.error('Model name already exists, please choose a different one');
			return;
		}
		setLoading(true);
		try {
			await onSubmit(buildArenaModel({ id, name, profileImageUrl, description, modelIds, filterMode, accessGrants }));
		} finally {
			setLoading(false);
		}
		onOpenChange(false);
	};

	const field = 'w-full bg-transparent text-sm';
	return (
		<>
			<ConfirmDialog
				open={confirmDelete}
				onOpenChange={setConfirmDelete}
				title={`Delete "${model?.name}"?`}
				confirmLabel="Delete arena model"
				destructive
				onConfirm={async () => {
					setConfirmDelete(false);
					await onDelete?.();
					onOpenChange(false);
				}}
			>
				Chats stop offering it once you save the Evaluations tab. Its settings cannot be recovered.
			</ConfirmDialog>

			<Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
				<DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
					{guard.dialog}
					<DialogHeader>
						<DialogTitle className="text-sm font-medium">{edit ? 'Edit arena model' : 'Add arena model'}</DialogTitle>
						<DialogDescription className="sr-only">An alias the arena chooses between.</DialogDescription>
					</DialogHeader>
					<form
						onSubmit={(e) => {
							e.preventDefault();
							submit();
						}}
					>
						<div className="flex gap-2">
							<div className="shrink-0">
								<input
									ref={imageInput}
									type="file"
									hidden
									accept="image/*"
									aria-label="Upload image"
									onChange={(e) => pickImage(e.target.files)}
								/>
								<ImageButton
									shape="circle"
									aria-label="Change image"
									overlay={<Pencil />}
									onClick={() => imageInput.current?.click()}
								>
									<ProfileAvatar src={profileImageUrl} name={name} className="size-12 text-base" />
								</ImageButton>
							</div>
							<div className="flex min-w-0 flex-1 flex-col gap-1">
								<div>
									<label className="text-muted-foreground text-xs" htmlFor="arena-name">
										Name
									</label>
									<input
										id="arena-name"
										className={field}
										type="text"
										value={name}
										onChange={(e) => changeName(e.target.value)}
										placeholder="Model Name"
										autoComplete="off"
										required
									/>
								</div>
								<div>
									<label className="text-muted-foreground text-xs" htmlFor="arena-id">
										ID
									</label>
									<input
										id="arena-id"
										className={`${field} disabled:opacity-60`}
										type="text"
										value={id}
										onChange={(e) => setId(e.target.value)}
										placeholder="Model ID"
										autoComplete="off"
										required
										disabled={edit}
									/>
								</div>
							</div>
						</div>

						<div className="mt-2">
							<label className="text-muted-foreground text-xs" htmlFor="arena-description">
								Description
							</label>
							<input
								id="arena-description"
								className={field}
								type="text"
								value={description}
								onChange={(e) => setDescription(e.target.value)}
								placeholder="Enter description"
								autoComplete="off"
							/>
						</div>

						<hr className="my-2" />
						<AccessControl
							accessGrants={accessGrants as never}
							onChange={(grants) => setAccessGrants(grants)}
							accessRoles={['read']}
						/>
						<hr className="my-2" />

						<div>
							<div className="flex items-center justify-between">
								<div className="text-muted-foreground text-xs">Models</div>
								<Button
									variant="link"
									size="sm"
									type="button"
									onClick={() => setFilterMode((m) => (m === 'include' ? 'exclude' : 'include'))}
								>
									{filterMode === 'include' ? 'Include' : 'Exclude'}
								</Button>
							</div>
							{modelIds.length > 0 ? (
								<div className="mt-1 flex flex-col gap-1">
									{modelIds.map((modelId) => (
										<div key={modelId} className="flex items-center justify-between text-xs">
											<div>{known.find((m) => m.id === modelId)?.name ?? modelId}</div>
											<Button
												variant="ghost"
												size="icon-sm"
												type="button"
												aria-label={`Remove ${modelId}`}
												onClick={() => setModelIds((ids) => ids.filter((x) => x !== modelId))}
											>
												<Minus className="size-3.5" strokeWidth={2} />
											</Button>
										</div>
									))}
								</div>
							) : (
								<div className="text-muted-foreground mt-1 text-xs">
									Leave empty to include all models or select specific models
								</div>
							)}
						</div>

						<hr className="my-2" />
						<div className="flex items-center gap-2">
							<select
								className="w-full bg-transparent text-sm"
								aria-label="Select a model"
								value={selectedModelId}
								onChange={(e) => setSelectedModelId(e.target.value)}
							>
								<option value="">Select a model</option>
								{known
									.filter((m) => m?.owned_by !== 'arena' && !modelIds.includes(m?.id))
									.map((m) => (
										<option key={m.id} value={m.id}>
											{m.name}
										</option>
									))}
							</select>
							<Button
								variant="ghost"
								size="icon-sm"
								type="button"
								aria-label="Add model"
								onClick={() => {
									if (selectedModelId && !modelIds.includes(selectedModelId))
										setModelIds((ids) => [...ids, selectedModelId]);
									setSelectedModelId('');
								}}
							>
								<Plus className="size-3.5" strokeWidth={2} />
							</Button>
						</div>

						<div className="flex justify-end gap-1.5 pt-3">
							{edit && (
								<Button type="button" variant="ghost" size="sm" onClick={() => setConfirmDelete(true)}>
									Delete
								</Button>
							)}
							<Button type="submit" size="sm" disabled={loading}>
								{edit ? 'Apply' : 'Add arena model'}
								{loading && <Spinner className="size-3.5" />}
							</Button>
						</div>
					</form>
				</DialogContent>
			</Dialog>
		</>
	);
}
