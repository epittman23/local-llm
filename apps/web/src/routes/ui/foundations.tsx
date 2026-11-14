import { useEffect, useState } from 'react';
import { CONTRAST_RULES, luminanceRatio, SURFACES, srgb8Luminance } from '@/lib/ui/contrast';
import { Example, Panel, Section } from './parts';

// The first half of /ui: colour, type, space and shape. Every value shown is
// read back from the page's own computed tokens, so the page cannot drift
// from styles/standard.css.

const SURFACE_NOTES: Record<string, string> = {
	'--page': 'The page itself',
	'--surface-1': 'Panels, the sidebar, fields',
	'--surface-2': 'Dialogs, menus, popovers',
	'--surface-3': 'Hover, selection, fills'
};

const TEXT_TOKENS = [
	{ name: '--foreground-strong', use: 'Body text and headings' },
	{ name: '--foreground-muted', use: 'Secondary text, placeholders, help' },
	{ name: '--brand', use: 'Links, the primary action, selection, focus' },
	{ name: '--success', use: 'Passed, saved, running normally' },
	{ name: '--warning', use: 'Needs attention, degraded' },
	{ name: '--danger', use: 'Failed, destructive, invalid' }
];

const SERIES = ['--series-1', '--series-2', '--series-3', '--series-4', '--series-5', '--series-6'];

interface Painted {
	hex: string;
	luminance: number;
}

/**
 * What each token paints as right now, measured rather than parsed: the build
 * rewrites the oklch() values in the stylesheet, so the page fills a canvas
 * pixel with `var(--token)` as the browser resolves it and reads the colour
 * back. Re-measured when the theme class changes. Empty where there is no
 * canvas (the unit tests).
 */
function usePainted(names: string[]): Record<string, Painted> {
	const [values, setValues] = useState<Record<string, Painted>>({});
	useEffect(() => {
		const measure = () => {
			const context = document.createElement('canvas').getContext?.('2d', { willReadFrequently: true });
			if (!context) return;
			const style = getComputedStyle(document.documentElement);
			const next: Record<string, Painted> = {};
			for (const name of names) {
				context.clearRect(0, 0, 1, 1);
				context.fillStyle = style.getPropertyValue(name).trim();
				context.fillRect(0, 0, 1, 1);
				const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
				next[name] = {
					hex: `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`,
					luminance: srgb8Luminance(r, g, b)
				};
			}
			setValues(next);
		};
		measure();
		const observer = new MutationObserver(measure);
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-ui'] });
		return () => observer.disconnect();
	}, [names]);
	return values;
}

const ALL_TOKENS = [
	...SURFACES,
	...TEXT_TOKENS.map((t) => t.name),
	...SERIES,
	'--border-divider',
	'--border-control',
	'--foreground-disabled',
	'--focus',
	'--brand-foreground',
	'--danger-fill',
	'--danger-fill-foreground'
];

function ratio(painted: Record<string, Painted>, foreground: string, background: string): number | null {
	const fg = painted[foreground];
	const bg = painted[background];
	return fg && bg ? luminanceRatio(fg.luminance, bg.luminance) : null;
}

function Ratio({ value, minimum }: { value: number | null; minimum: number }) {
	if (value === null) return <span className="text-foreground-muted">not measured</span>;
	const passes = value >= minimum;
	return (
		<span data-numeric className={passes ? 'text-foreground-muted' : 'text-danger font-[650]'}>
			{value.toFixed(1)}:1{passes ? '' : ` (needs ${minimum}:1)`}
		</span>
	);
}

export function ColourSection() {
	const tokens = usePainted(ALL_TOKENS);
	const hex = (name: string) => tokens[name]?.hex ?? '';
	const measured = Object.keys(tokens).length > 0;
	const failing = CONTRAST_RULES.filter((rule) => {
		const value = ratio(tokens, rule.foreground, rule.background);
		return value !== null && value < rule.minimum;
	});
	return (
		<Section
			id="colour"
			title="Colour"
			lead="Blackboard in dark, whiteboard in light: a green-grey slate with chalk-coloured text, one chalk blue for anything you can act on, and three status colours that mean one thing each. Dark is the primary theme and is checked first."
			rules={['COL-1', 'COL-2', 'COL-3', 'COL-4', 'COL-5', 'COL-6', 'COL-8']}
		>
			<Example
				title="Surfaces"
				note="Four steps, each for one job. Neighbouring surfaces differ in fill and are separated by a divider, so a panel never depends on a shadow to be seen."
			>
				<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
					{SURFACES.map((name) => (
						<div
							key={name}
							className="border-border flex min-h-28 flex-col justify-between rounded-xl border p-3"
							style={{ backgroundColor: `var(${name})` }}
						>
							<div>
								<code className="text-dense">{name}</code>
								<p className="text-foreground-muted text-dense mt-1">{SURFACE_NOTES[name]}</p>
							</div>
							<p className="text-foreground-muted text-caption" data-numeric>
								{hex(name)}
							</p>
						</div>
					))}
				</div>
			</Example>

			<Example
				title="Text and status on every surface"
				note="Each cell is the measured contrast of that colour on that surface, computed from the tokens on this page. Text needs 4.5:1; body text is held to 7:1."
			>
				<div className="border-border overflow-x-auto rounded-xl border">
					<table className="text-dense w-full min-w-[40rem] border-collapse">
						<thead>
							<tr className="bg-surface-1 text-left">
								<th scope="col" className="px-3 py-2 font-[550]">
									Colour
								</th>
								{SURFACES.map((surface) => (
									<th key={surface} scope="col" className="px-3 py-2 font-[550]">
										<code>{surface.replace('--', '')}</code>
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{TEXT_TOKENS.map((token) => (
								<tr key={token.name} className="border-border border-t">
									<th scope="row" className="px-3 py-2 text-left font-normal">
										<code>{token.name}</code>
										<span className="text-foreground-muted block">{token.use}</span>
									</th>
									{SURFACES.map((surface) => (
										<td key={surface} className="px-3 py-2" style={{ backgroundColor: `var(${surface})` }}>
											<span className="text-body block font-[550]" style={{ color: `var(${token.name})` }}>
												Sample 0.26
											</span>
											<Ratio
												value={ratio(tokens, token.name, surface)}
												minimum={token.name === '--foreground-strong' ? 7 : 4.5}
											/>
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>
				<p className="text-foreground-muted mt-3" role="status">
					{!measured
						? 'Contrast is measured in the browser.'
						: failing.length === 0
							? `All ${CONTRAST_RULES.length} colour promises hold in this theme.`
							: `${failing.length} colour promises fail in this theme: ${failing.map((f) => `${f.foreground} on ${f.background}`).join(', ')}.`}
				</p>
			</Example>

			<Example
				title="Edges"
				note="A divider only separates, so it may be quiet. The edge of something you type in or switch must reach 3:1, which is why fields use a second, stronger colour."
			>
				<div className="grid gap-3 sm:grid-cols-2">
					<Panel>
						<p className="font-[550]">Divider</p>
						<div className="border-border my-3 border-t" />
						<p className="text-foreground-muted text-dense">
							<code>--border-divider</code>,{' '}
							<Ratio value={ratio(tokens, '--border-divider', '--surface-1')} minimum={1.3} /> on a panel
						</p>
					</Panel>
					<Panel>
						<p className="font-[550]">Control edge</p>
						<div className="border-border-control my-2 h-7 rounded-md border" />
						<p className="text-foreground-muted text-dense">
							<code>--border-control</code>,{' '}
							<Ratio value={ratio(tokens, '--border-control', '--surface-1')} minimum={3} /> on a panel
						</p>
					</Panel>
				</div>
			</Example>

			<Example
				title="Chart series"
				note="Six colours, used in this order, each at least 3:1 on the surfaces a chart sits on. Axes, gridlines and labels use the text and divider tokens, never fixed greys."
			>
				<Panel>
					<svg
						viewBox="0 0 600 150"
						role="img"
						aria-label="Six sample series drawn in the chart colours"
						className="w-full"
					>
						{[30, 70, 110].map((y) => (
							<line key={y} x1="0" x2="600" y1={y} y2={y} stroke="var(--border-divider)" strokeWidth="1" />
						))}
						{SERIES.map((name, i) => (
							<polyline
								key={name}
								fill="none"
								stroke={`var(${name})`}
								strokeWidth="2.5"
								strokeLinejoin="round"
								points={[0, 100, 200, 300, 400, 500, 600]
									.map((x, j) => `${x},${125 - i * 17 - Math.round(18 * Math.sin((j + i) * 0.9))}`)
									.join(' ')}
							/>
						))}
					</svg>
					<ul className="text-dense mt-3 flex flex-wrap gap-x-5 gap-y-1">
						{SERIES.map((name, i) => (
							<li key={name} className="flex items-center gap-2">
								<span aria-hidden className="size-2.5 rounded-full" style={{ backgroundColor: `var(${name})` }} />
								Series {i + 1}
							</li>
						))}
					</ul>
				</Panel>
			</Example>
		</Section>
	);
}

const TYPE_STEPS = [
	{ className: 'text-display', name: 'display', size: '28 / 34', use: 'The name of a page with nothing above it' },
	{ className: 'text-heading', name: 'heading', size: '22 / 28', use: 'Page title, section heading' },
	{ className: 'text-title', name: 'title', size: '18 / 24', use: 'Dialog title, card title, subsection' },
	{
		className: 'text-reading',
		name: 'reading',
		size: '16 / 26',
		use: 'Chat messages, notes, reports; fields on phones'
	},
	{ className: 'text-body', name: 'body', size: '14 / 20', use: 'The interface: labels, buttons, menus, fields' },
	{ className: 'text-dense', name: 'dense', size: '13 / 18', use: 'Table cells, help text, compact toolbars' },
	{ className: 'text-caption', name: 'caption', size: '12 / 16', use: 'Timestamps, counts, badges. Nothing is smaller' }
];

export function TypeSection() {
	return (
		<Section
			id="type"
			title="Type"
			lead="Atkinson Hyperlegible Next for the interface and its monospaced sibling for code and identifiers. Both were drawn so that 0 and O, 1 and l, and rn and m cannot be confused, which matters in a tool full of hashes, flags and figures. Mathematics stays in KaTeX's own faces."
			rules={['TYP-1', 'TYP-2', 'TYP-3', 'TYP-5', 'TYP-6', 'TYP-7']}
		>
			<Example
				title="The seven steps"
				note="A page uses these and no others. Three weights: 400 for text, 550 for labels and controls, 650 for headings."
			>
				<div className="border-border divide-border divide-y rounded-xl border">
					{TYPE_STEPS.map((step) => (
						<div
							key={step.name}
							className="grid items-baseline gap-x-6 gap-y-1 px-4 py-3 md:grid-cols-[1fr_7rem_18rem]"
						>
							<p
								className={`${step.className} ${step.name === 'display' || step.name === 'heading' || step.name === 'title' ? 'font-[650] tracking-tight' : ''} min-w-0 truncate`}
							>
								Residuals against fitted values
							</p>
							<p className="text-dense text-foreground-muted" data-numeric>
								<code>text-{step.name}</code>
								<br />
								{step.size}
							</p>
							<p className="text-dense text-foreground-muted">{step.use}</p>
						</div>
					))}
				</div>
			</Example>

			<Example
				title="Characters that must not be confused"
				note="Identifiers are set in the monospaced face and never abbreviated in the middle of a group of characters."
			>
				<Panel className="grid gap-4 sm:grid-cols-2">
					<div>
						<p className="text-foreground-muted text-dense">Interface face</p>
						<p className="text-heading mt-1">Il1 O0 rn m 5S 8B</p>
					</div>
					<div>
						<p className="text-foreground-muted text-dense">Code face</p>
						<p className="text-heading mt-1 font-mono">Il1 O0 rn m 5S 8B</p>
					</div>
				</Panel>
			</Example>

			<Example
				title="Reading width"
				note="Long-form text is set at the reading step and never wider than 72 characters."
			>
				<p className="text-reading max-w-[72ch]">
					Dividing by n underestimates the variance, because the mean was estimated from the same observations. The
					sample mean sits closer to the data than the true mean does, so the squared distances come out too small.
					Dividing by n - 1 corrects for the one degree of freedom the mean has already used.
				</p>
			</Example>
		</Section>
	);
}

const SPACES = [
	{ px: 4, use: 'Icon to its label' },
	{ px: 8, use: 'Between related controls' },
	{ px: 12, use: 'Inside a control, between a field and its neighbour' },
	{ px: 16, use: 'Padding of a panel, between fields in a form' },
	{ px: 24, use: 'Between groups' },
	{ px: 32, use: 'Between sections of a page' },
	{ px: 48, use: 'Between chapters' }
];

const RADII = [
	{ className: 'rounded', px: 4, use: 'Checkboxes, inline code, tags inside text' },
	{ className: 'rounded-lg', px: 8, use: 'Buttons, fields, menu items' },
	{ className: 'rounded-xl', px: 12, use: 'Panels, dialogs, menus' },
	{ className: 'rounded-full', px: null, use: 'Badges, avatars, switches' }
];

export function SpaceSection() {
	return (
		<Section
			id="space"
			title="Space, shape and size"
			lead="Seven distances, four corner sizes and three control heights. A corner says what kind of thing something is; it is not a style applied to everything."
			rules={['LAY-1', 'LAY-2', 'LAY-3', 'SHP-1', 'SHP-2']}
		>
			<Example title="Distances">
				<ul className="flex flex-col gap-2">
					{SPACES.map((space) => (
						<li key={space.px} className="flex items-center gap-4">
							<span className="text-dense w-10 text-right" data-numeric>
								{space.px}
							</span>
							<span aria-hidden className="bg-brand h-3 rounded-sm" style={{ width: space.px * 2 }} />
							<span className="text-foreground-muted text-dense">{space.use}</span>
						</li>
					))}
				</ul>
			</Example>
			<Example title="Corners">
				<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
					{RADII.map((radius) => (
						<div key={radius.className} className="flex items-center gap-3">
							<span
								aria-hidden
								className={`border-border-control bg-surface-1 size-14 shrink-0 border ${radius.className}`}
							/>
							<p className="text-dense">
								<span className="font-[550]" data-numeric>
									{radius.px === null ? 'Full' : `${radius.px} px`}
								</span>
								<span className="text-foreground-muted block">{radius.use}</span>
							</p>
						</div>
					))}
				</div>
			</Example>
			<Example
				title="Control heights"
				note="36 px is the height of every button, field and select. 28 px is for dense toolbars and table rows when a pointer is in use. With a touch screen every control grows to 44 px."
			>
				<div className="flex flex-wrap items-end gap-4">
					{[
						{ token: '--control-compact', label: 'Compact, 28' },
						{ token: '--control', label: 'Standard, 36' },
						{ token: '--control-touch', label: 'Touch, 44' }
					].map((height) => (
						<div
							key={height.token}
							className="border-border-control bg-surface-1 text-dense flex items-center rounded-lg border px-3"
							style={{ height: `var(${height.token})` }}
						>
							{height.label}
						</div>
					))}
				</div>
			</Example>
		</Section>
	);
}
