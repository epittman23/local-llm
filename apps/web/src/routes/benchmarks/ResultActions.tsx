import { ArrowRightLeftIcon, CircleCheckIcon, PlayIcon, SquarePenIcon, TriangleAlertIcon } from 'lucide-react';
import { Link } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { routePaths } from '@/routes/routePaths';
import { knobName, profileVersionLink, serveLink, splitKnobs } from './resultLinks';

export type Tone = 'success' | 'warning' | 'danger' | 'secondary';

/** DAT-3: a state as its word in its colour, with an icon unless it is neutral. */
export function StatusBadge({ label, tone }: { label: string; tone: Tone }) {
	const Icon = tone === 'success' ? CircleCheckIcon : tone === 'secondary' ? null : TriangleAlertIcon;
	return (
		<Badge variant={tone}>
			{Icon && <Icon aria-hidden data-icon="inline-start" />}
			{label}
		</Badge>
	);
}

/**
 * B-D8: what a Tune winner or a pre-screen candidate can become. Serve with
 * these overrides fills the Serve form; Create profile version opens the
 * profile's Edit form with the fields changed; Compare opens the
 * configuration comparison against a baseline. Each is only a link: nothing
 * starts and nothing is saved until the person does it there. A line says
 * which knobs each one carries.
 */
export function ResultActions({
	profile,
	overrides,
	note,
	compareBaseline,
	size = 'default',
	label,
	showNote = true
}: {
	profile: string;
	overrides: Record<string, unknown> | null | undefined;
	/** The new version's note. */
	note: string;
	/** A config_id for Compare's baseline; no Compare link without one. */
	compareBaseline?: string | null;
	size?: 'default' | 'sm';
	/** Names the result the links act on, for a row of them ("candidate 2"). */
	label?: string;
	/** The line saying which knobs each link carries; a table says it once instead. */
	showNote?: boolean;
}) {
	const toServe = serveLink(profile, overrides);
	const toVersion = profileVersionLink(profile, overrides, note);
	const toCompare = compareBaseline
		? `${routePaths.benchmarksCompare}?${new URLSearchParams({ by: 'config', baseline: compareBaseline })}`
		: null;
	if (!toServe && !toVersion && !toCompare) return null;
	const knobs = splitKnobs(overrides);
	const of = label ? `, ${label}` : '';
	return (
		<div className="flex flex-col gap-2">
			<div className="flex flex-wrap gap-2">
				{toServe && (
					<Button asChild variant="outline" size={size}>
						<Link to={toServe} aria-label={label ? `Serve with these overrides${of}` : undefined}>
							<PlayIcon aria-hidden data-icon="inline-start" />
							Serve with these overrides
						</Link>
					</Button>
				)}
				{toVersion && (
					<Button asChild variant="outline" size={size}>
						<Link to={toVersion} aria-label={label ? `Create profile version${of}` : undefined}>
							<SquarePenIcon aria-hidden data-icon="inline-start" />
							Create profile version
						</Link>
					</Button>
				)}
				{toCompare && (
					<Button asChild variant="outline" size={size}>
						<Link to={toCompare}>
							<ArrowRightLeftIcon aria-hidden data-icon="inline-start" />
							Compare
						</Link>
					</Button>
				)}
			</div>
			{showNote && <KnobsNote {...knobs} />}
		</div>
	);
}

/** Which knobs each link carries (WRD-2), so a partial Serve link is not mistaken for the whole change. */
export function KnobsNote({
	serve,
	version,
	unsupported
}: {
	serve: string[];
	version: string[];
	unsupported: string[];
}) {
	const names = (keys: string[]) => keys.map(knobName).join(', ');
	const notServed = version.filter((k) => !serve.includes(k));
	const parts: string[] = [];
	if (serve.length > 0 && notServed.length === 0) parts.push('Serve takes all of these as one-off overrides.');
	if (serve.length > 0 && notServed.length > 0)
		parts.push(`Serve takes ${names(serve)} only; ${names(notServed)} needs a new profile version.`);
	if (serve.length === 0 && version.length > 0) parts.push(`${names(version)} needs a new profile version.`);
	if (unsupported.length > 0)
		parts.push(`${names(unsupported)} has no profile field: add it to the profile's extra arguments by hand.`);
	if (parts.length === 0) return null;
	return <p className="text-muted-foreground text-dense">{parts.join(' ')}</p>;
}
