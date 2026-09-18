import { useQuery } from '@tanstack/react-query';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { listProfileVersions } from '@/lib/apis/benchmarks/profiles';
import { useAuthStore } from '@/lib/stores/authStore';

/** Renders `notes` per version, per Phase 5's own checklist wording (docs/migration-plan.md). */
export function ProfileVersionHistory({ profileName }: { profileName: string }) {
	const token = useAuthStore((state) => state.token) ?? '';

	const versionsQuery = useQuery({
		queryKey: ['profile-versions', profileName],
		queryFn: () => listProfileVersions(token, profileName),
		enabled: !!token && !!profileName
	});

	if (versionsQuery.isLoading) {
		return <p className="text-muted-foreground text-sm">Loading versions…</p>;
	}

	const versions = versionsQuery.data ?? [];

	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead>Version</TableHead>
					<TableHead>Created</TableHead>
					<TableHead>Notes</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{versions.map((v) => (
					<TableRow key={v.version_id}>
						<TableCell>{v.version}</TableCell>
						<TableCell>{new Date(v.created_at * 1000).toLocaleString()}</TableCell>
						<TableCell className="max-w-md whitespace-pre-wrap">{v.notes || '—'}</TableCell>
					</TableRow>
				))}
				{versions.length === 0 && (
					<TableRow>
						<TableCell colSpan={3} className="text-muted-foreground text-center">
							No versions
						</TableCell>
					</TableRow>
				)}
			</TableBody>
		</Table>
	);
}
