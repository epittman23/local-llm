import { Tip } from '@/components/common/Tip';

/** Ports common/ExperimentalBadge.svelte: a small "Experimental" label with an explanatory tooltip. */
export function ExperimentalBadge() {
	return (
		<Tip content="This is an experimental feature, it may not function as expected and is subject to change at any time.">
			<span className="text-muted-foreground/70 inline-flex text-[0.625rem] leading-none font-normal uppercase">Experimental</span>
		</Tip>
	);
}
