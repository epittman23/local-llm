import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArchiveIcon, ArchiveRestoreIcon, CopyIcon, MoreHorizontal, StarIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { toastFailure } from '@/components/common/failureToast';
import { ListEmptyState } from '@/components/common/ListChrome';
import { LoadFailed } from '@/components/common/LoadFailed';
import { Spinner } from '@/components/common/Spinner';
import { TableSkeleton } from '@/components/common/TableSkeleton';
import { FormField } from '@/components/settings/formFields';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
	addProfileVersion,
	archiveProfile,
	cloneProfile,
	createProfile,
	getProfile,
	listProfiles,
	type ProfileDefinition,
	type ProfileEntry,
	setDefaultProfile,
	unarchiveProfile
} from '@/lib/apis/benchmarks/profiles';
import { useAuthStore } from '@/lib/stores/authStore';
import { useFieldErrors } from '@/lib/ui/useFieldErrors';
import { useConfirmLeave } from '@/lib/ui/useUnsavedChanges';
import { nameProblem, ProfileDefinitionForm } from './ProfileDefinitionForm';
import { ProfileVersionHistory } from './ProfileVersionHistory';
import { prefillFromParams } from './profileForm';

type View =
	| { mode: 'list' }
	| { mode: 'create' }
	| { mode: 'clone'; name: string }
	| {
			mode: 'edit';
			name: string;
			version: number;
			definition: ProfileDefinition;
			prefill?: Partial<ProfileDefinition>;
			note?: string;
	  }
	| { mode: 'history'; name: string };

const LIST: View = { mode: 'list' };

/** The fields of a version row that are not part of its definition. */
const definitionOf = (version: ProfileEntry['version']): ProfileDefinition => {
	const { version_id, profile_id, version: _n, created_at, created_by, note, ...definition } = version;
	return definition as ProfileDefinition;
};

/** The model file's name, without the folder it lives in. */
const fileName = (path: string) => path.split('/').pop() || path;

/**
 * Backs decision 11 in docs/history/migration-plan.md ("Full CRUD from the Serve
 * page"): the profiles router's create, clone, new version, set default and
 * archive. `name` is never editable after creation, matching that router.
 *
 * #977: one row per profile, its name over its display name, version and
 * model file, with its state as badges; Edit and History beside it and the
 * rest in its menu (OVL-3), so the row fits at 390 px. The dialog reopens on
 * the list. Create and Edit hold a draft (FRM-3): closing asks first.
 * `?edit=<profile>&def.<field>=` opens a new version prefilled (B-D8).
 */
export function ProfilesPanel({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const token = useAuthStore((state) => state.token) ?? '';
	const queryClient = useQueryClient();
	const [params] = useSearchParams();
	const [view, setView] = useState<View>(LIST);
	const [serverError, setServerError] = useState<string | null>(null);
	const [draftDirty, setDraftDirty] = useState(false);
	const [opening, setOpening] = useState<string | null>(null);

	const guard = useConfirmLeave(open && view.mode !== 'list' && view.mode !== 'history' && draftDirty, {
		message: 'This profile is not saved. What you entered is lost if you leave.'
	});

	const go = useCallback((next: View) => {
		setServerError(null);
		setDraftDirty(false);
		setView(next);
	}, []);
	const back = () => guard.confirmLeave(() => go(LIST));
	const close = () =>
		guard.confirmLeave(() => {
			go(LIST);
			onOpenChange(false);
		});

	const profilesQuery = useQuery({
		queryKey: ['profiles', 'all'],
		queryFn: () => listProfiles(token, true),
		enabled: !!token && open
	});

	const invalidateAll = () =>
		Promise.all([
			queryClient.invalidateQueries({ queryKey: ['profiles'] }),
			queryClient.invalidateQueries({ queryKey: ['serve-profiles'] }),
			queryClient.invalidateQueries({ queryKey: ['profile-versions'] })
		]);
	const refuse = (err: unknown) => setServerError(String(err));

	const setDefaultMutation = useMutation({
		mutationFn: (name: string) => setDefaultProfile(token, name),
		onSuccess: async (_, name) => {
			await invalidateAll();
			toast.success(`${name} is now the default profile`);
		},
		onError: (err, name) => toastFailure(`Couldn't make ${name} the default`, err)
	});

	const archiveMutation = useMutation({
		mutationFn: ({ name, archived }: { name: string; archived: boolean }) =>
			archived ? unarchiveProfile(token, name) : archiveProfile(token, name),
		onSuccess: async (_, { name, archived }) => {
			await invalidateAll();
			// ACT-3: archiving can be undone, so it happens at once and the toast offers Undo.
			if (archived) toast.success(`${name} restored`);
			else
				toast.success(`${name} archived`, {
					action: { label: 'Undo', onClick: () => archiveMutation.mutate({ name, archived: true }) }
				});
		},
		onError: (err, { name, archived }) => toastFailure(`Couldn't ${archived ? 'restore' : 'archive'} ${name}`, err)
	});

	const createMutation = useMutation({
		mutationFn: (form: { name: string; display_name: string; definition: ProfileDefinition; note: string }) =>
			createProfile(token, form),
		onMutate: () => setServerError(null),
		onSuccess: async (_, form) => {
			await invalidateAll();
			go(LIST);
			toast.success(`Profile ${form.name} created`);
		},
		onError: refuse
	});

	const cloneMutation = useMutation({
		mutationFn: ({ source, form }: { source: string; form: { name: string; display_name: string; note: string } }) =>
			cloneProfile(token, source, form),
		onMutate: () => setServerError(null),
		onSuccess: async (_, { form }) => {
			await invalidateAll();
			go(LIST);
			toast.success(`Profile ${form.name} created`);
		},
		onError: refuse
	});

	const addVersionMutation = useMutation({
		mutationFn: ({ name, definition, note }: { name: string; definition: ProfileDefinition; note: string }) =>
			addProfileVersion(token, name, { definition, note }),
		onMutate: () => setServerError(null),
		onSuccess: async (entry, { name }) => {
			await invalidateAll();
			go(LIST);
			toast.success(`Version ${entry?.version?.version ?? ''} of ${name} saved`.replace('  ', ' '));
		},
		onError: refuse
	});

	const openEdit = useCallback(
		async (name: string, prefill?: { changes: Partial<ProfileDefinition>; note: string }) => {
			setOpening(name);
			try {
				const entry = await getProfile(token, name);
				go({
					mode: 'edit',
					name,
					version: entry.version.version,
					definition: definitionOf(entry.version),
					prefill: prefill?.changes,
					note: prefill?.note
				});
			} catch (err) {
				toastFailure(`Couldn't open ${name}`, err);
			} finally {
				setOpening(null);
			}
		},
		[token, go]
	);

	// B-D8: a "Create profile version" link opens the prefilled edit as the dialog opens. Read once per
	// link (the parameters as they were then); the page removes them when the dialog closes.
	const paramsNow = useRef(params);
	paramsNow.current = params;
	const editLink = open ? params.get('edit') : null;
	useEffect(() => {
		if (!editLink || !token) return;
		const prefill = prefillFromParams(paramsNow.current);
		if (prefill) void openEdit(prefill.name, prefill);
	}, [editLink, token, openEdit]);

	const profiles = profilesQuery.data ?? [];

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (next) onOpenChange(true);
				else close();
			}}
		>
			<DialogContent className="sm:max-w-3xl">
				<DialogHeader>
					<DialogTitle className="text-title font-title tracking-tight">
						{view.mode === 'list' && 'Manage profiles'}
						{view.mode === 'create' && 'Create profile'}
						{view.mode === 'clone' && `Clone ${view.name}`}
						{view.mode === 'edit' && `New version of ${view.name}`}
						{view.mode === 'history' && `${view.name} — version history`}
					</DialogTitle>
				</DialogHeader>

				{view.mode === 'list' && (
					<>
						<DialogBody>
							{profilesQuery.isLoading ? (
								<TableSkeleton label="profiles" rows={3} />
							) : profilesQuery.isError ? (
								<LoadFailed
									what="profiles"
									error={profilesQuery.error}
									onRetry={() => profilesQuery.refetch()}
									retrying={profilesQuery.isFetching}
								/>
							) : profiles.length === 0 ? (
								<ListEmptyState
									title="No profiles yet"
									description="A profile is a model file and the llama-server settings it is served with."
									action={<Button onClick={() => go({ mode: 'create' })}>Create profile</Button>}
								/>
							) : (
								<Table aria-label="Profiles">
									<TableHeader>
										<TableRow>
											<TableHead scope="col">Profile</TableHead>
											<TableHead scope="col" className="text-right">
												<span className="sr-only">Actions</span>
											</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{profiles.map((entry) => (
											<ProfileRow
												key={entry.profile.profile_id}
												entry={entry}
												opening={opening === entry.profile.name}
												onEdit={() => openEdit(entry.profile.name)}
												onHistory={() => go({ mode: 'history', name: entry.profile.name })}
												onClone={() => go({ mode: 'clone', name: entry.profile.name })}
												onSetDefault={() => setDefaultMutation.mutate(entry.profile.name)}
												onArchive={() =>
													archiveMutation.mutate({ name: entry.profile.name, archived: !!entry.profile.archived_at })
												}
											/>
										))}
									</TableBody>
								</Table>
							)}
						</DialogBody>
						{profiles.length > 0 && (
							<DialogFooter>
								<Button onClick={() => go({ mode: 'create' })}>Create profile</Button>
							</DialogFooter>
						)}
					</>
				)}

				{view.mode === 'history' && (
					<>
						<DialogBody>
							<ProfileVersionHistory profileName={view.name} />
						</DialogBody>
						<DialogFooter>
							<Button variant="outline" onClick={() => go(LIST)}>
								Back to profiles
							</Button>
						</DialogFooter>
					</>
				)}

				{view.mode === 'create' && (
					<ProfileDefinitionForm
						withIdentity
						submitLabel="Create profile"
						busyLabel="Creating…"
						pending={createMutation.isPending}
						serverError={serverError}
						onDirtyChange={setDraftDirty}
						onCancel={back}
						onSubmit={(definition, note, identity) =>
							createMutation.mutate({ name: identity.name, display_name: identity.displayName, definition, note })
						}
					/>
				)}

				{view.mode === 'clone' && (
					<CloneForm
						source={view.name}
						pending={cloneMutation.isPending}
						serverError={serverError}
						onDirtyChange={setDraftDirty}
						onCancel={back}
						onSubmit={(name, displayName) =>
							cloneMutation.mutate({ source: view.name, form: { name, display_name: displayName, note: '' } })
						}
					/>
				)}

				{view.mode === 'edit' && (
					<ProfileDefinitionForm
						key={`${view.name}-${view.version}`}
						initial={view.definition}
						baselineVersion={view.version}
						prefill={view.prefill}
						initialNote={view.note}
						submitLabel="Save as new version"
						pending={addVersionMutation.isPending}
						serverError={serverError}
						onDirtyChange={setDraftDirty}
						onCancel={back}
						onSubmit={(definition, note) => addVersionMutation.mutate({ name: view.name, definition, note })}
					/>
				)}
				{guard.dialog}
			</DialogContent>
		</Dialog>
	);
}

/** One profile: what it is on the left, Edit and History beside it, the rest in its menu (#977, OVL-3). */
function ProfileRow({
	entry,
	opening,
	onEdit,
	onHistory,
	onClone,
	onSetDefault,
	onArchive
}: {
	entry: ProfileEntry;
	opening: boolean;
	onEdit: () => void;
	onHistory: () => void;
	onClone: () => void;
	onSetDefault: () => void;
	onArchive: () => void;
}) {
	const { profile, version } = entry;
	const archived = !!profile.archived_at;
	return (
		// Below sm the actions go on their own line under the profile, so its name and file keep the width (#977).
		<TableRow className="max-sm:flex max-sm:flex-col">
			<TableCell className="whitespace-normal max-sm:pb-0">
				<div className="flex flex-wrap items-center gap-2">
					<span className="font-mono font-strong break-all">{profile.name}</span>
					{profile.is_default && <Badge variant="secondary">Default</Badge>}
					{archived && <Badge variant="secondary">Archived</Badge>}
				</div>
				<p className="mt-0.5">{profile.display_name}</p>
				<p className="text-foreground-muted text-dense mt-0.5 break-all">
					Version {version.version} · <span className="font-mono">{fileName(version.model_path)}</span>
				</p>
			</TableCell>
			<TableCell className="w-0 align-top max-sm:w-full">
				<div className="flex items-center justify-end gap-1 max-sm:-ms-2 max-sm:justify-start">
					<Button
						size="sm"
						variant="ghost"
						onClick={onEdit}
						disabled={archived || opening}
						aria-busy={opening || undefined}
						aria-label={`Edit ${profile.name}`}
					>
						{opening && <Spinner className="size-3.5" />}
						Edit
					</Button>
					<Button size="sm" variant="ghost" onClick={onHistory} aria-label={`History of ${profile.name}`}>
						History
					</Button>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button variant="ghost" size="icon-sm" aria-label={`More actions for ${profile.name}`}>
								<MoreHorizontal aria-hidden className="size-3.5" />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="w-auto min-w-48">
							<DropdownMenuItem onSelect={onClone}>
								<CopyIcon aria-hidden />
								Clone
							</DropdownMenuItem>
							{!profile.is_default && !archived && (
								<DropdownMenuItem onSelect={onSetDefault}>
									<StarIcon aria-hidden />
									Make default
								</DropdownMenuItem>
							)}
							{!profile.is_default && (
								<>
									<DropdownMenuSeparator />
									<DropdownMenuItem onSelect={onArchive}>
										{archived ? <ArchiveRestoreIcon aria-hidden /> : <ArchiveIcon aria-hidden />}
										{archived ? 'Restore' : 'Archive'}
									</DropdownMenuItem>
								</>
							)}
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			</TableCell>
		</TableRow>
	);
}

/** Clone: a new name and display name for a copy of the profile's current definition. */
function CloneForm({
	source,
	pending,
	serverError,
	onDirtyChange,
	onCancel,
	onSubmit
}: {
	source: string;
	pending: boolean;
	serverError: string | null;
	onDirtyChange: (dirty: boolean) => void;
	onCancel: () => void;
	onSubmit: (name: string, displayName: string) => void;
}) {
	const [name, setName] = useState('');
	const [displayName, setDisplayName] = useState('');
	const problems: Partial<Record<'name' | 'displayName', string>> = {
		name: nameProblem(name),
		displayName: displayName.trim() ? undefined : 'Enter a display name for the copy.'
	};
	const { errors, field, submit } = useFieldErrors(problems, ['name', 'displayName'] as const, { inDialog: true });
	const dirty = name !== '' || displayName !== '';
	useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
	return (
		<form
			noValidate
			className="flex min-h-0 flex-1 flex-col gap-4"
			onSubmit={(e) => {
				e.preventDefault();
				if (submit()) onSubmit(name, displayName.trim());
			}}
		>
			<DialogBody>
				<p className="text-foreground-muted">
					The copy starts identical to {source}'s current version. Only its name and display name differ.
				</p>
				<div className="grid gap-3 sm:grid-cols-2">
					<FormField id="clone-name" label="Name" error={errors.name ?? serverError ?? undefined}>
						{(props) => (
							<Input
								{...props}
								{...field('name')}
								autoComplete="off"
								className="font-mono"
								value={name}
								onChange={(e) => setName(e.target.value)}
							/>
						)}
					</FormField>
					<FormField id="clone-display-name" label="Display name" error={errors.displayName}>
						{(props) => (
							<Input
								{...props}
								{...field('displayName')}
								autoComplete="off"
								value={displayName}
								onChange={(e) => setDisplayName(e.target.value)}
							/>
						)}
					</FormField>
				</div>
			</DialogBody>
			<DialogFooter>
				<Button type="button" variant="outline" onClick={onCancel}>
					Cancel
				</Button>
				<Button type="submit" disabled={pending} aria-busy={pending || undefined}>
					{pending && <Spinner className="size-3.5" />}
					{pending ? 'Cloning…' : `Clone ${source}`}
				</Button>
			</DialogFooter>
		</form>
	);
}
