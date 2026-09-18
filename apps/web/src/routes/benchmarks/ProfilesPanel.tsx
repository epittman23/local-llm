import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
	addProfileVersion,
	archiveProfile,
	cloneProfile,
	createProfile,
	getProfile,
	listProfiles,
	setDefaultProfile,
	unarchiveProfile,
	type ProfileDefinition
} from '@/lib/apis/benchmarks/profiles';
import { useAuthStore } from '@/lib/stores/authStore';
import { ProfileDefinitionForm } from './ProfileDefinitionForm';
import { ProfileVersionHistory } from './ProfileVersionHistory';

type View =
	| { mode: 'list' }
	| { mode: 'create' }
	| { mode: 'clone'; name: string }
	| { mode: 'edit'; name: string; definition: ProfileDefinition }
	| { mode: 'history'; name: string };

/**
 * Backs decision 11 in docs/migration-plan.md ("Full CRUD from the Serve
 * page") -- genuinely new UI, not a port: Serve.svelte never built one (see
 * this file's own git history / ProfileDefinitionForm.tsx's docstring), even
 * though the backend CRUD router (routers/benchmarks/profiles.py) has been
 * there since Phase 2a. `name` is never editable here, matching that
 * router's own DefinitionForm having no `name` field at all.
 */
export function ProfilesPanel({
	open,
	onOpenChange
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const token = useAuthStore((state) => state.token) ?? '';
	const queryClient = useQueryClient();
	const [view, setView] = useState<View>({ mode: 'list' });
	const [error, setError] = useState<string | null>(null);
	const [newName, setNewName] = useState('');
	const [newDisplayName, setNewDisplayName] = useState('');

	const profilesQuery = useQuery({
		queryKey: ['profiles', 'all'],
		queryFn: () => listProfiles(token, true),
		enabled: !!token && open
	});

	const invalidateAll = () =>
		Promise.all([
			queryClient.invalidateQueries({ queryKey: ['profiles'] }),
			queryClient.invalidateQueries({ queryKey: ['serve-profiles'] })
		]);

	const setDefaultMutation = useMutation({
		mutationFn: (name: string) => setDefaultProfile(token, name),
		onSuccess: invalidateAll,
		onError: (err: any) => setError(err?.detail ?? String(err))
	});

	const archiveMutation = useMutation({
		mutationFn: ({ name, archived }: { name: string; archived: boolean }) =>
			archived ? unarchiveProfile(token, name) : archiveProfile(token, name),
		onSuccess: invalidateAll,
		onError: (err: any) => setError(err?.detail ?? String(err))
	});

	const createMutation = useMutation({
		mutationFn: (form: { name: string; display_name: string; definition: ProfileDefinition; note: string }) =>
			createProfile(token, form),
		onSuccess: async () => {
			await invalidateAll();
			setView({ mode: 'list' });
		},
		onError: (err: any) => setError(err?.detail ?? String(err))
	});

	const cloneMutation = useMutation({
		mutationFn: ({
			source,
			form
		}: {
			source: string;
			form: { name: string; display_name: string; note: string };
		}) => cloneProfile(token, source, form),
		onSuccess: async () => {
			await invalidateAll();
			setView({ mode: 'list' });
		},
		onError: (err: any) => setError(err?.detail ?? String(err))
	});

	const addVersionMutation = useMutation({
		mutationFn: ({
			name,
			definition,
			note
		}: {
			name: string;
			definition: ProfileDefinition;
			note: string;
		}) => addProfileVersion(token, name, { definition, note }),
		onSuccess: async () => {
			await invalidateAll();
			setView({ mode: 'list' });
		},
		onError: (err: any) => setError(err?.detail ?? String(err))
	});

	const openEdit = async (name: string) => {
		setError(null);
		try {
			const entry = await getProfile(token, name);
			const { version_id, profile_id, version, created_at, created_by, note, ...definition } =
				entry.version;
			setView({ mode: 'edit', name, definition: definition as ProfileDefinition });
		} catch (err: any) {
			setError(err?.detail ?? String(err));
		}
	};

	const profiles = profilesQuery.data ?? [];

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
				<DialogHeader>
					<DialogTitle>
						{view.mode === 'list' && 'Manage profiles'}
						{view.mode === 'create' && 'Create profile'}
						{view.mode === 'clone' && `Clone ${view.name}`}
						{view.mode === 'edit' && `New version of ${view.name}`}
						{view.mode === 'history' && `${view.name} — version history`}
					</DialogTitle>
				</DialogHeader>

				{error && (
					<div className="border-destructive/20 bg-destructive/10 text-destructive rounded-lg border px-3 py-2 text-xs">
						{error}
					</div>
				)}

				{view.mode === 'list' && (
					<div className="flex flex-col gap-3">
						<div className="flex justify-end">
							<Button size="sm" onClick={() => setView({ mode: 'create' })}>
								Create profile
							</Button>
						</div>
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Name</TableHead>
									<TableHead>Display name</TableHead>
									<TableHead>Status</TableHead>
									<TableHead className="text-right">Actions</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{profiles.map((entry) => (
									<TableRow key={entry.profile.profile_id}>
										<TableCell className="font-mono text-xs">{entry.profile.name}</TableCell>
										<TableCell>{entry.profile.display_name}</TableCell>
										<TableCell className="flex gap-1">
											{entry.profile.is_default && <Badge>default</Badge>}
											{entry.profile.archived_at && <Badge variant="secondary">archived</Badge>}
										</TableCell>
										<TableCell className="flex flex-wrap justify-end gap-1">
											<Button
												size="sm"
												variant="ghost"
												onClick={() => setView({ mode: 'history', name: entry.profile.name })}
											>
												History
											</Button>
											<Button
												size="sm"
												variant="ghost"
												onClick={() => openEdit(entry.profile.name)}
												disabled={!!entry.profile.archived_at}
											>
												Edit
											</Button>
											<Button
												size="sm"
												variant="ghost"
												onClick={() => setView({ mode: 'clone', name: entry.profile.name })}
											>
												Clone
											</Button>
											{!entry.profile.is_default && !entry.profile.archived_at && (
												<Button
													size="sm"
													variant="ghost"
													onClick={() => setDefaultMutation.mutate(entry.profile.name)}
												>
													Set default
												</Button>
											)}
											{!entry.profile.is_default && (
												<Button
													size="sm"
													variant="ghost"
													onClick={() =>
														archiveMutation.mutate({
															name: entry.profile.name,
															archived: !!entry.profile.archived_at
														})
													}
												>
													{entry.profile.archived_at ? 'Unarchive' : 'Archive'}
												</Button>
											)}
										</TableCell>
									</TableRow>
								))}
								{profiles.length === 0 && (
									<TableRow>
										<TableCell colSpan={4} className="text-muted-foreground text-center">
											No profiles
										</TableCell>
									</TableRow>
								)}
							</TableBody>
						</Table>
					</div>
				)}

				{view.mode === 'history' && (
					<div className="flex flex-col gap-3">
						<ProfileVersionHistory profileName={view.name} />
						<div className="flex justify-end">
							<Button variant="ghost" onClick={() => setView({ mode: 'list' })}>
								Back
							</Button>
						</div>
					</div>
				)}

				{view.mode === 'create' && (
					<div className="flex flex-col gap-3">
						<div className="grid grid-cols-2 gap-3">
							<div className="flex flex-col gap-1">
								<Label htmlFor="new-profile-name">name (immutable after creation)</Label>
								<Input
									id="new-profile-name"
									required
									value={newName}
									onChange={(e) => setNewName(e.target.value)}
								/>
							</div>
							<div className="flex flex-col gap-1">
								<Label htmlFor="new-profile-display-name">display_name</Label>
								<Input
									id="new-profile-display-name"
									required
									value={newDisplayName}
									onChange={(e) => setNewDisplayName(e.target.value)}
								/>
							</div>
						</div>
						<ProfileDefinitionForm
							submitLabel="Create"
							pending={createMutation.isPending}
							onCancel={() => setView({ mode: 'list' })}
							onSubmit={(definition, note) =>
								createMutation.mutate({ name: newName, display_name: newDisplayName, definition, note })
							}
						/>
					</div>
				)}

				{view.mode === 'clone' && (
					<div className="flex flex-col gap-3">
						<p className="text-muted-foreground text-sm">
							The clone starts identical to {view.name}'s current definition -- only its name and
							display name differ.
						</p>
						<div className="grid grid-cols-2 gap-3">
							<div className="flex flex-col gap-1">
								<Label htmlFor="clone-profile-name">name</Label>
								<Input
									id="clone-profile-name"
									required
									value={newName}
									onChange={(e) => setNewName(e.target.value)}
								/>
							</div>
							<div className="flex flex-col gap-1">
								<Label htmlFor="clone-profile-display-name">display_name</Label>
								<Input
									id="clone-profile-display-name"
									required
									value={newDisplayName}
									onChange={(e) => setNewDisplayName(e.target.value)}
								/>
							</div>
						</div>
						<div className="flex justify-end gap-2">
							<Button variant="ghost" onClick={() => setView({ mode: 'list' })}>
								Cancel
							</Button>
							<Button
								disabled={cloneMutation.isPending}
								onClick={() =>
									'name' in view &&
									cloneMutation.mutate({
										source: view.name,
										form: { name: newName, display_name: newDisplayName, note: '' }
									})
								}
							>
								{cloneMutation.isPending ? 'Cloning…' : 'Clone'}
							</Button>
						</div>
					</div>
				)}

				{view.mode === 'edit' && (
					<ProfileDefinitionForm
						initial={view.definition}
						submitLabel="Save as new version"
						pending={addVersionMutation.isPending}
						onCancel={() => setView({ mode: 'list' })}
						onSubmit={(definition, note) =>
							addVersionMutation.mutate({ name: view.name, definition, note })
						}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}
