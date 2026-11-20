import { useQuery } from '@tanstack/react-query';
import { LoadFailed } from '@/components/common/LoadFailed';
import { Disclosure } from '@/components/settings/formFields';
import { Badge } from '@/components/ui/badge';
import { listProfileVersions, type ProfileVersionModel } from '@/lib/apis/benchmarks/profiles';
import { useAuthStore } from '@/lib/stores/authStore';
import { ChangeList } from './ProfileDefinitionForm';
import { type DefinitionKey, definitionChanges, FIELD_META, recordTime, showValue } from './profileForm';

/**
 * A profile's versions, newest first (#978): each one's own version note
 * (why it was made), when (DAT-5's record format), what changed from the
 * version before it, and its whole definition behind a disclosure.
 */
export function ProfileVersionHistory({ profileName }: { profileName: string }) {
	const token = useAuthStore((state) => state.token) ?? '';

	const versionsQuery = useQuery({
		queryKey: ['profile-versions', profileName],
		queryFn: () => listProfileVersions(token, profileName),
		enabled: !!token && !!profileName
	});

	if (versionsQuery.isLoading) {
		return (
			<div aria-busy className="flex flex-col gap-3">
				<div className="bg-surface-3 h-24 animate-pulse rounded-lg" />
				<div className="bg-surface-3 h-24 animate-pulse rounded-lg" />
			</div>
		);
	}
	if (versionsQuery.isError) {
		return (
			<LoadFailed
				what="the version history"
				error={versionsQuery.error}
				onRetry={() => versionsQuery.refetch()}
				retrying={versionsQuery.isFetching}
			/>
		);
	}

	const versions = versionsQuery.data ?? [];
	if (versions.length === 0) return <p className="text-foreground-muted">This profile has no versions.</p>;
	const byNumber = new Map(versions.map((v) => [v.version, v]));
	const newest = Math.max(...versions.map((v) => v.version));

	return (
		<ol aria-label={`Versions of ${profileName}`} className="flex flex-col gap-3">
			{versions.map((v) => {
				const previous = byNumber.get(v.version - 1);
				const changes = previous ? definitionChanges(previous, v) : [];
				return (
					<li key={v.version_id} className="flex flex-col gap-2 rounded-lg border p-3">
						<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
							<h3 className="font-strong">Version {v.version}</h3>
							{v.version === newest && <Badge variant="secondary">Current</Badge>}
							<time className="text-foreground-muted text-dense" dateTime={new Date(v.created_at * 1000).toISOString()}>
								{recordTime(v.created_at)}
							</time>
						</div>
						<p className={v.note ? 'max-w-[72ch] whitespace-pre-wrap' : 'text-foreground-muted'}>
							{v.note || 'No version note.'}
						</p>
						{previous ? (
							changes.length ? (
								<div className="flex flex-col gap-1">
									<p className="text-foreground-muted text-dense">Changes from version {previous.version}</p>
									<ChangeList changes={changes} />
								</div>
							) : (
								<p className="text-foreground-muted text-dense">Same definition as version {previous.version}.</p>
							)
						) : (
							v.version === 1 && <p className="text-foreground-muted text-dense">The first version.</p>
						)}
						<Disclosure title="Definition" description={`Every setting of version ${v.version}`}>
							<Definition version={v} />
						</Disclosure>
					</li>
				);
			})}
		</ol>
	);
}

function Definition({ version }: { version: ProfileVersionModel }) {
	const keys = (Object.keys(FIELD_META) as DefinitionKey[]).filter((key) => key !== 'notes');
	return (
		<div className="flex flex-col gap-3">
			<dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1 text-dense">
				{keys.map((key) => (
					<div key={key} className="contents">
						<dt className="text-foreground-muted">{FIELD_META[key].label}</dt>
						<dd className="min-w-0 font-mono break-words">{showValue(key, version[key])}</dd>
					</div>
				))}
			</dl>
			{version.notes && (
				<div className="flex flex-col gap-1">
					<p className="text-foreground-muted text-dense">Notes</p>
					<p className="text-dense max-w-[72ch] whitespace-pre-wrap">{version.notes}</p>
				</div>
			)}
		</div>
	);
}
