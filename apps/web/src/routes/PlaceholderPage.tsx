/**
 * Stands in for a surface this migration hasn't ported yet (Phases 5-10 own
 * these one at a time -- see docs/migration-plan.md). A real React route
 * exists so the sidebar can link to it with react-router's own <Link>
 * instead of a full-page <a>, without pretending the surface is finished.
 */
export function PlaceholderPage({ title, phase }: { title: string; phase: string }) {
	return (
		<div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
			<h1 className="text-xl font-semibold">{title}</h1>
			<p className="text-muted-foreground max-w-sm text-sm">
				Not built yet in this app -- {phase} of the Astro/React migration.
			</p>
		</div>
	);
}
