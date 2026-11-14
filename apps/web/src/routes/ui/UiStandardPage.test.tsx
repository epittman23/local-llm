import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { UiStandardPage } from './UiStandardPage';

const renderPage = () =>
	render(
		<TooltipProvider>
			<UiStandardPage />
			<Toaster />
		</TooltipProvider>
	);

describe('UiStandardPage (/ui)', () => {
	afterEach(() => {
		cleanup();
		localStorage.clear();
		document.documentElement.className = '';
	});

	it('switches the scoped standard layer on while mounted, and off again', () => {
		const { unmount } = renderPage();
		expect(document.documentElement.dataset.ui).toBe('standard');
		expect(document.title).toBe('Interface standard · local-llm');
		unmount();
		expect(document.documentElement.dataset.ui).toBeUndefined();
	});

	it('has one h1 and a section for every entry in its navigation', () => {
		renderPage();
		expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
		const links = within(screen.getByRole('navigation', { name: 'Sections' })).getAllByRole('link');
		expect(links.length).toBeGreaterThanOrEqual(10);
		for (const link of links) {
			const id = link.getAttribute('href')?.slice(1) ?? '';
			expect(document.getElementById(id)?.tagName, `section #${id}`).toBe('SECTION');
		}
	});

	it('cites only rules that docs/guides/ui-standard.md defines', () => {
		renderPage();
		// Vitest runs from apps/web.
		const standard = readFileSync(resolve(process.cwd(), '../../docs/guides/ui-standard.md'), 'utf8');
		const cited = new Set(
			[...document.querySelectorAll('section code')]
				.map((code) => code.textContent ?? '')
				.filter((text) => /^[A-Z0-9]+-\d+$/.test(text))
		);
		expect(cited.size).toBeGreaterThan(40);
		expect([...cited].filter((rule) => !standard.includes(`**${rule}.`))).toEqual([]);
	});

	it('changes the theme class from its theme switch', () => {
		renderPage();
		fireEvent.click(screen.getByRole('button', { name: 'Dark' }));
		expect(document.documentElement.classList.contains('dark')).toBe(true);
		expect(screen.getByRole('button', { name: 'Dark' }).getAttribute('aria-pressed')).toBe('true');
		fireEvent.click(screen.getByRole('button', { name: 'Light' }));
		expect(document.documentElement.classList.contains('dark')).toBe(false);
	});

	it('shows a field error in place, tied to its field, and reports unsaved changes', () => {
		renderPage();
		const context = screen.getByLabelText('Context size, tokens');
		expect(context.getAttribute('aria-invalid')).toBe('true');
		const note = document.getElementById(context.getAttribute('aria-describedby') ?? '');
		expect(note?.textContent).toContain('between 512 and 32768');

		expect(screen.getByText('All changes saved')).toBeTruthy();
		fireEvent.change(context, { target: { value: '8192' } });
		expect(context.getAttribute('aria-invalid')).toBeNull();
		expect(screen.getByText('Unsaved changes')).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
		expect(screen.getByText('All changes saved')).toBeTruthy();

		fireEvent.change(screen.getByLabelText('Profile name'), { target: { value: 'qwen36-b' } });
		fireEvent.change(context, { target: { value: '8192' } });
		fireEvent.submit(context.closest('form') as HTMLFormElement);
		expect(screen.getByText('All changes saved')).toBeTruthy();
	});

	it('shows each of the four list states', () => {
		renderPage();
		expect(screen.getByText('No prompts yet')).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Loading' }));
		expect(screen.getByText('Loading prompts')).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'No results' }));
		expect(screen.getByRole('button', { name: 'Clear search' })).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Failed' }));
		expect(screen.getByText('Prompts could not be loaded')).toBeTruthy();
	});

	it('gives every icon-only button a name, and toggles line wrapping in code', () => {
		renderPage();
		for (const name of ['Copy answer', 'Edit message', 'Try again', 'More actions for this chat']) {
			expect(screen.getAllByRole('button', { name }).length).toBeGreaterThan(0);
		}
		fireEvent.click(screen.getByRole('button', { name: 'Copy answer' }));
		fireEvent.click(screen.getByRole('button', { name: 'Show a confirmation' }));
		fireEvent.click(screen.getByRole('button', { name: 'Show a failure' }));
		fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
		const wrap = screen.getByRole('button', { name: 'Wrap lines' });
		fireEvent.click(wrap);
		expect(wrap.getAttribute('aria-pressed')).toBe('true');
		fireEvent.click(screen.getByRole('switch', { name: 'Name new chats automatically' }));
		expect(screen.getByText('Off. Applied.')).toBeTruthy();
	});

	it('opens the destructive confirmation with Cancel and a named action', () => {
		renderPage();
		fireEvent.click(screen.getByRole('button', { name: 'Delete collection' }));
		const dialog = screen.getByRole('alertdialog');
		expect(within(dialog).getByText('Delete “Course notes”?')).toBeTruthy();
		expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeTruthy();
		fireEvent.click(within(dialog).getByRole('button', { name: 'Delete collection' }));
	});
});
