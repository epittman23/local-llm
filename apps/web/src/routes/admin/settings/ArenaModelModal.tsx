import { useQuery } from '@tanstack/react-query';
import { Minus, Pencil, Plus } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AccessControl } from '@/components/common/AccessControl';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { Spinner } from '@/components/common/Spinner';
import { FieldLabel, FormField } from '@/components/settings/formFields';
import { ProfileAvatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FieldMessage } from '@/components/ui/field-message';
import { ImageButton } from '@/components/ui/image-button';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { getModels } from '@/lib/apis';
import { WEBUI_BASE_URL } from '@/lib/constants';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfirmLeave } from '@/lib/ui/useUnsavedChanges';
import { ACCEPTED_IMAGE_TYPES, resizeToDataUrl } from '@/lib/utils/image';
import { useAdminSingleUser } from '../adminVisibility';
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
	const ids = useId();
	const fieldId = (name: string) => `${ids}-${name}`;
	const [errors, setErrors] = useState<{ name?: string; id?: string }>({});
	// S5-D2: who may use it says nothing while the install has one account and sign-ups are off.
	const singleUser = useAdminSingleUser();
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
		setErrors({});
		setInitial(JSON.stringify(start));
		// Seeded when the dialog opens; edits inside it are local.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	const known = models.data ?? [];
	const changeName = (value: string) => {
		setName(value);
		setErrors({});
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
		// FRM-2: what is wrong is said under the field, which takes focus.
		const problem: { name?: string; id?: string } = !name
			? { name: 'Enter a name for the arena model.' }
			: !id
				? { id: 'Enter an ID.' }
				: !edit && known.some((m) => m.name === name)
					? { name: 'A model already has this name. Choose another.' }
					: {};
		if (problem.name || problem.id) {
			setErrors(problem);
			document.getElementById(fieldId(problem.name ? 'name' : 'id'))?.focus();
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
				<DialogContent className="sm:max-w-lg">
					{guard.dialog}
					<DialogHeader>
						<DialogTitle>{edit ? 'Edit arena model' : 'Add arena model'}</DialogTitle>
						<DialogDescription className="sr-only">An alias the arena chooses between.</DialogDescription>
					</DialogHeader>
					<form
						noValidate
						// min-w-0: a grid item, so a long model name in the select cannot widen the dialog past its edge.
						className="flex min-w-0 flex-col gap-4"
						onSubmit={(e) => {
							e.preventDefault();
							submit();
						}}
					>
						<div className="flex items-start gap-3">
							<div className="shrink-0 pt-6">
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
							<div className="flex min-w-0 flex-1 flex-col gap-4">
								<FormField id={fieldId('name')} label="Name" error={errors.name}>
									{(props) => (
										<Input
											{...props}
											value={name}
											onChange={(e) => changeName(e.target.value)}
											placeholder="Model name"
											autoComplete="off"
										/>
									)}
								</FormField>
								<FormField
									id={fieldId('id')}
									label="ID"
									error={errors.id}
									help={edit ? "An arena model's ID can't be changed." : undefined}
								>
									{(props) => (
										<Input
											{...props}
											className="font-mono"
											value={id}
											onChange={(e) => {
												setId(e.target.value);
												setErrors({});
											}}
											placeholder="model-id"
											autoComplete="off"
											disabled={edit}
										/>
									)}
								</FormField>
							</div>
						</div>

						<FormField id={fieldId('description')} label="Description" optional>
							{(props) => (
								<Input
									{...props}
									value={description}
									onChange={(e) => setDescription(e.target.value)}
									placeholder="What it compares"
									autoComplete="off"
								/>
							)}
						</FormField>

						{!singleUser && (
							<AccessControl
								accessGrants={accessGrants as never}
								onChange={(grants) => setAccessGrants(grants)}
								accessRoles={['read']}
							/>
						)}

						<div className="flex flex-col">
							<FieldLabel>
								<span id={fieldId('models-label')}>Models</span>
							</FieldLabel>
							<SegmentedControl
								aria-labelledby={fieldId('models-label')}
								aria-describedby={fieldId('models-message')}
								value={filterMode}
								onValueChange={setFilterMode}
								options={[
									{ value: 'include', label: 'Only these' },
									{ value: 'exclude', label: 'All but these' }
								]}
								className="self-start"
							/>
							{modelIds.length > 0 && (
								<ul aria-label="Chosen models" className="mt-2 flex flex-col gap-1">
									{modelIds.map((modelId) => (
										<li key={modelId} className="flex items-center justify-between gap-2 text-dense">
											<span className="min-w-0 truncate">{known.find((m) => m.id === modelId)?.name ?? modelId}</span>
											<Button
												variant="ghost"
												size="icon-sm"
												type="button"
												aria-label={`Remove ${modelId}`}
												onClick={() => setModelIds((ids) => ids.filter((x) => x !== modelId))}
											>
												<Minus aria-hidden />
											</Button>
										</li>
									))}
								</ul>
							)}
							<div className="mt-2 flex items-center gap-2">
								<select
									className="min-w-0 flex-1"
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
									variant="outline"
									size="icon"
									type="button"
									aria-label="Add model"
									onClick={() => {
										if (selectedModelId && !modelIds.includes(selectedModelId))
											setModelIds((ids) => [...ids, selectedModelId]);
										setSelectedModelId('');
									}}
								>
									<Plus aria-hidden />
								</Button>
							</div>
							<FieldMessage
								id={fieldId('models-message')}
								className="mt-1.5"
								help={
									modelIds.length === 0
										? 'None chosen: the arena picks among all your models.'
										: filterMode === 'include'
											? 'The arena picks among these models only.'
											: 'The arena picks among all your models except these.'
								}
							/>
						</div>

						<div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
							<div>
								{edit && (
									<Button type="button" variant="destructive" onClick={() => setConfirmDelete(true)}>
										Delete
									</Button>
								)}
							</div>
							<Button type="submit" disabled={loading} aria-busy={loading || undefined}>
								{loading && <Spinner className="size-3.5" />}
								{edit ? 'Apply' : 'Add arena model'}
							</Button>
						</div>
					</form>
				</DialogContent>
			</Dialog>
		</>
	);
}
