import { useEffect, useState } from 'react';
import { Katex } from '@/components/chat/markdown/Katex';
import { Button } from '@/components/ui/button';
import { applyTheme, getTheme } from '@/lib/theme';
import {
	ActionsSection,
	ContentSection,
	DataSection,
	FeedbackSection,
	FormsSection,
	NavigationSection,
	StatesSection,
	StatusBadge
} from './components';
import { ColourSection, SpaceSection, TypeSection } from './foundations';
import type { SectionMeta } from './parts';

/**
 * /ui: the interface standard (docs/guides/ui-standard.md) applied to the
 * shared components and to the patterns pages are built from. It is the
 * reference a UI change is compared with, in dark first.
 *
 * The standard's values are not the app's defaults yet. While this page is
 * mounted it sets `data-ui="standard"` on <html>, which switches on the scoped
 * layer in styles/standard.css; leaving the page removes it. The attribute is
 * on <html> rather than a wrapper because dialogs, menus and toasts render in
 * portals outside any wrapper.
 */

const SECTIONS: SectionMeta[] = [
	{ id: 'colour', title: 'Colour' },
	{ id: 'type', title: 'Type' },
	{ id: 'space', title: 'Space, shape and size' },
	{ id: 'actions', title: 'Actions' },
	{ id: 'forms', title: 'Forms' },
	{ id: 'data', title: 'Tables and figures' },
	{ id: 'navigation', title: 'Pages and navigation' },
	{ id: 'feedback', title: 'Feedback and overlays' },
	{ id: 'states', title: 'Loading, empty and failed' },
	{ id: 'content', title: 'Answers' }
];

const THEME_CHOICES = [
	{ id: 'dark', label: 'Dark' },
	{ id: 'oled-dark', label: 'Black' },
	{ id: 'light', label: 'Light' }
];

function ThemeSwitch() {
	const [theme, setTheme] = useState(getTheme);
	return (
		<fieldset className="flex items-center gap-1">
			<legend className="sr-only">Theme</legend>
			{THEME_CHOICES.map((choice) => (
				<Button
					key={choice.id}
					size="sm"
					variant={theme === choice.id ? 'secondary' : 'ghost'}
					aria-pressed={theme === choice.id}
					onClick={() => {
						applyTheme(choice.id);
						setTheme(choice.id);
					}}
				>
					{choice.label}
				</Button>
			))}
		</fieldset>
	);
}

/** The opening specimen: the three things this app shows (an answer, an equation, a measurement) set in the standard. */
function Specimen() {
	return (
		<div className="border-border bg-surface-1 rounded-xl border">
			<div className="border-border flex items-center justify-between gap-3 border-b px-4 py-2.5">
				<p className="font-[550]">qwen36</p>
				<StatusBadge status="success">Serving</StatusBadge>
			</div>
			<div className="text-reading flex flex-col gap-3 px-4 py-4">
				<p>The standard error shrinks with the square root of the sample size:</p>
				<div className="overflow-x-auto">
					<Katex content="\mathrm{SE}(\bar{x}) = \frac{s}{\sqrt{n}}" displayMode />
				</div>
			</div>
			<dl className="border-border text-dense grid grid-cols-3 border-t">
				{[
					['Generation', '7.6', 'tokens/s'],
					['Pass rate', '81.7', '%'],
					['Peak VRAM', '5,571', 'MiB']
				].map(([label, value, unit]) => (
					<div key={label} className="border-border px-4 py-3 not-first:border-l">
						<dt className="text-foreground-muted">{label}</dt>
						<dd className="text-title mt-0.5 font-[650]" data-numeric>
							{value} <span className="text-dense text-foreground-muted font-normal">{unit}</span>
						</dd>
					</div>
				))}
			</dl>
		</div>
	);
}

export function UiStandardPage() {
	useEffect(() => {
		const root = document.documentElement;
		const previousTitle = document.title;
		root.dataset.ui = 'standard';
		document.title = 'Interface standard · local-llm';
		return () => {
			delete root.dataset.ui;
			document.title = previousTitle;
		};
	}, []);

	return (
		<div className="bg-background text-foreground min-h-screen">
			<a
				href="#standard-main"
				className="bg-brand text-brand-foreground sr-only rounded-lg px-3 py-2 focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50"
			>
				Skip to the standard
			</a>
			<header className="border-border border-b">
				<div className="mx-auto flex max-w-[76rem] flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
					<a href="/" className="font-[650]">
						local-llm
					</a>
					<ThemeSwitch />
				</div>
			</header>

			<div className="mx-auto grid max-w-[76rem] gap-x-12 px-4 sm:px-6 lg:grid-cols-[13rem_minmax(0,1fr)]">
				<nav aria-label="Sections" className="hidden lg:block">
					<ul className="sticky top-6 mt-12 flex flex-col gap-0.5">
						{SECTIONS.map((section) => (
							<li key={section.id}>
								<a
									href={`#${section.id}`}
									className="text-foreground-muted hover:bg-surface-3 hover:text-foreground block rounded-lg px-2.5 py-1.5"
								>
									{section.title}
								</a>
							</li>
						))}
					</ul>
				</nav>

				<main id="standard-main" className="min-w-0">
					<div className="grid items-center gap-8 py-12 xl:grid-cols-[minmax(0,1fr)_24rem]">
						<div>
							<h1 className="text-display font-[650] tracking-tight">Interface standard</h1>
							<p className="text-reading text-foreground-muted mt-3 max-w-[60ch]">
								One set of rules for every page of local-llm, shown here on the real shared components. A change to the
								interface is correct when it looks and behaves like this page, in dark first.
							</p>
							<p className="text-foreground-muted mt-3 max-w-[60ch]">
								The rules, with their identifiers, are in <code>docs/guides/ui-standard.md</code>. These values apply to
								this page only until the rest of the app is moved onto them.
							</p>
						</div>
						<Specimen />
					</div>

					<ColourSection />
					<TypeSection />
					<SpaceSection />
					<ActionsSection />
					<FormsSection />
					<DataSection />
					<NavigationSection />
					<FeedbackSection />
					<StatesSection />
					<ContentSection />
				</main>
			</div>
		</div>
	);
}
