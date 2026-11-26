import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { UiStandardPage } from './UiStandardPage';

// The rendered answer and the replies use the chat's own components, which read settings and models through React Query.
// The Forms demo's unsaved-changes guard blocks navigation, which needs a data router.
const renderPage = () =>
	render(
		<QueryClientProvider client={new QueryClient()}>
			<TooltipProvider>
				<RouterProvider
					router={createMemoryRouter([{ path: '/ui', element: <UiStandardPage /> }], { initialEntries: ['/ui'] })}
				/>
				<Toaster />
			</TooltipProvider>
		</QueryClientProvider>
	);

describe('UiStandardPage (/ui)', () => {
	afterEach(() => {
		cleanup();
		localStorage.clear();
		document.documentElement.className = '';
	});

	it('leaves the tab title to its route, so it reads like every other page (LAY-5)', () => {
		document.title = 'before';
		const { unmount } = renderPage();
		expect(document.title).toBe('before');
		unmount();
		expect(document.title).toBe('before');
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
		// The app's themes by their names, less System: the page shows each one on purpose.
		const choices = within(screen.getByRole('group', { name: 'Theme' })).getAllByRole('button');
		expect(choices.map((b) => b.textContent)).toEqual(['Dark', 'Black', 'Light']);
		fireEvent.click(screen.getByRole('button', { name: 'Dark' }));
		expect(document.documentElement.classList.contains('dark')).toBe(true);
		expect(screen.getByRole('button', { name: 'Dark' }).getAttribute('aria-pressed')).toBe('true');
		fireEvent.click(screen.getByRole('button', { name: 'Light' }));
		expect(document.documentElement.classList.contains('dark')).toBe(false);
	});

	it('judges a field when it is left, shows the error in place, and reports unsaved changes', () => {
		renderPage();
		const context = screen.getByLabelText('Context size, tokens');
		expect(context.getAttribute('aria-invalid')).toBeNull();
		expect(within(context.closest('form') as HTMLFormElement).getByText('All changes saved')).toBeTruthy();

		// Typing does not raise the error; leaving the field does (FRM-2).
		fireEvent.change(context, { target: { value: '40000' } });
		expect(context.getAttribute('aria-invalid')).toBeNull();
		expect(screen.getByText('Unsaved changes')).toBeTruthy();
		fireEvent.blur(context);
		expect(context.getAttribute('aria-invalid')).toBe('true');
		const note = document.getElementById(context.getAttribute('aria-describedby') ?? '');
		expect(note?.textContent).toContain('between 512 and 32768');

		// Saving with the error keeps the changes pending.
		fireEvent.submit(context.closest('form') as HTMLFormElement);
		expect(screen.getByText('Unsaved changes')).toBeTruthy();

		fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
		expect(within(context.closest('form') as HTMLFormElement).getByText('All changes saved')).toBeTruthy();
		expect(context.getAttribute('aria-invalid')).toBeNull();

		fireEvent.change(screen.getByLabelText('Profile name'), { target: { value: 'demo-b' } });
		fireEvent.change(context, { target: { value: '4096' } });
		fireEvent.submit(context.closest('form') as HTMLFormElement);
		expect(within(context.closest('form') as HTMLFormElement).getByText('All changes saved')).toBeTruthy();
	});

	it('asks before unloading only while changes are unsaved', () => {
		renderPage();
		const unload = () => {
			const event = new Event('beforeunload', { cancelable: true });
			window.dispatchEvent(event);
			return event.defaultPrevented;
		};
		expect(unload()).toBe(false);
		fireEvent.change(screen.getByLabelText('Profile name'), { target: { value: 'demo-b' } });
		expect(unload()).toBe(true);
	});

	it('shows each of the four list states', () => {
		renderPage();
		expect(screen.getByText('No prompts yet')).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Loading' }));
		expect(screen.getByText('Loading prompts')).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'No results' }));
		expect(
			within(document.getElementById('states') as HTMLElement).getByRole('button', { name: 'Clear search' })
		).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Failed' }));
		const failed = within(document.getElementById('states') as HTMLElement).getByRole('alert');
		expect(failed.textContent).toContain("Couldn't load prompts");
		expect(within(failed).getByText('The server did not answer. It may be restarting or stopped.')).toBeTruthy();
		expect(within(failed).getByRole('button', { name: 'Try again' })).toBeTruthy();
	});

	it("raises a failure toast that names what was not saved, with the server's words behind Details (FBK-2, FBK-4)", async () => {
		renderPage();
		fireEvent.click(screen.getByRole('button', { name: 'Show a save failure' }));
		const message = await screen.findByText('Couldn’t save “Weekly summary”. Try again.');
		const toast = message.closest('li') as HTMLElement;
		expect(within(toast).getByText('Details').closest('details')).not.toHaveAttribute('open');
		expect(within(toast).getByText('database is locked')).toBeTruthy();
	});

	it('gives every icon-only button a name, and toggles line wrapping in code', () => {
		renderPage();
		for (const name of ['Copy answer', 'Edit message', 'Try again', 'More actions for this chat']) {
			expect(screen.getAllByRole('button', { name }).length).toBeGreaterThan(0);
		}
		fireEvent.click(screen.getByRole('button', { name: 'Copy answer' }));
		fireEvent.click(screen.getByRole('button', { name: 'Copy configuration example00a1' }));
		fireEvent.click(screen.getByRole('button', { name: 'Show a confirmation' }));
		fireEvent.click(screen.getByRole('button', { name: 'Show a failure' }));
		fireEvent.click(screen.getByRole('button', { name: 'Show a save failure' }));
		const answer = within(document.getElementById('content') as HTMLElement);
		expect(within(answer.getByTestId('code-block')).getByRole('button', { name: 'Copy' })).toBeTruthy();
		const wrap = answer.getByRole('button', { name: 'Wrap lines' });
		fireEvent.click(wrap);
		expect(wrap.getAttribute('aria-pressed')).toBe('true');
		fireEvent.click(screen.getByRole('switch', { name: 'Name new chats automatically' }));
		expect(screen.getByText('Off. Applied.')).toBeTruthy();
	});

	it("renders the answer sample with the chat's own renderer: a named table, an equation, task marks and a long code block", () => {
		renderPage();
		const answer = within(document.getElementById('content') as HTMLElement);
		expect(answer.getByRole('columnheader', { name: 'Test RMSE' })).toBeTruthy();
		expect(answer.getByRole('button', { name: 'Copy table' })).toBeTruthy();
		expect(answer.getByRole('figure', { name: 'Equation' })).toBeTruthy();
		expect(document.querySelectorAll('#content [data-slot="checkbox-mark"]')).toHaveLength(3);
		const block = within(answer.getByTestId('code-block'));
		expect(block.getByRole('figure', { name: 'python code' })).toBeTruthy();
		fireEvent.click(block.getByRole('button', { name: 'Collapse' }));
		expect(block.getByRole('button', { name: /Show all \d+ lines/ })).toBeTruthy();
	});

	it('shows a failed reply with its next steps, and the stopped and token-limit marks', () => {
		renderPage();
		const answer = within(document.getElementById('content') as HTMLElement);
		const failed = answer.getByRole('alert');
		expect(failed.textContent).toContain("The model didn't answer");
		expect(failed.textContent).toContain('Check the API key in Admin > Settings > Connections.');
		fireEvent.click(within(failed).getByRole('button', { name: 'Try another model' }));
		const cuts = answer.getAllByTestId('cut-off');
		expect(cuts.map((c) => c.textContent)).toEqual([
			expect.stringContaining('Stopped'),
			expect.stringContaining('Reached the token limit')
		]);
		for (const cut of cuts) {
			expect(within(cut).getByRole('button', { name: 'Continue' })).toBeTruthy();
			expect(within(cut).getByRole('button', { name: 'Regenerate' })).toBeTruthy();
		}
	});

	it('demonstrates the side panel: a resizable column that Escape closes from inside', () => {
		renderPage();
		const panel = screen.getByRole('complementary', { name: 'Side panel' });
		const separator = within(panel).getByRole('separator', { name: 'Resize side panel' });
		expect(separator.getAttribute('aria-valuenow')).toBe('288');
		fireEvent.keyDown(separator, { key: 'ArrowLeft' });
		expect(separator.getAttribute('aria-valuenow')).toBe('304');
		expect(localStorage.getItem('ui.sidePanel')).toBe('304');
		fireEvent.keyDown(separator, { key: 'Escape' });
		expect(screen.queryByRole('complementary', { name: 'Side panel' })).toBeNull();
		fireEvent.click(screen.getByRole('button', { name: 'Open the side panel' }));
		expect(screen.getByRole('complementary', { name: 'Side panel' })).toBeTruthy();
	});

	it('opens a document from its card in the canvas, in the view its kind has', () => {
		renderPage();
		const canvas = () => screen.getByRole('complementary', { name: 'Canvas' });
		// Opens on the page: a sandboxed frame with scripts and nothing else (CNV-5).
		const frame = canvas().querySelector('iframe');
		expect(frame?.getAttribute('sandbox')).toBe('allow-scripts');
		expect(frame?.getAttribute('srcdoc')).toContain('Standard error explorer');
		expect(screen.getByRole('button', { name: /Standard error explorer/, current: true })).toBeTruthy();

		fireEvent.click(within(canvas()).getByRole('button', { name: 'Source' }));
		expect(canvas().querySelector('iframe')).toBeNull();
		expect(canvas().querySelector('pre')?.textContent).toContain('<!doctype html>');
		// Highlighted by highlight.js, as the chat's code blocks are.
		expect(canvas().querySelector('pre .hljs-name')?.textContent).toBe('html');
		fireEvent.click(within(canvas()).getByRole('button', { name: 'Preview' }));
		fireEvent.click(within(canvas()).getByRole('button', { name: 'Reload the page' }));
		fireEvent.click(within(canvas()).getByRole('button', { name: 'Expand to the full width' }));
		fireEvent.click(within(canvas()).getByRole('button', { name: 'Show the chat beside it' }));

		// A script has no preview: source only, and no view switch.
		fireEvent.click(screen.getByRole('button', { name: /fit\.py/ }));
		expect(within(canvas()).queryByRole('button', { name: 'Preview' })).toBeNull();
		expect(canvas().querySelector('pre')?.textContent).toContain('def standard_error');
		expect(canvas().querySelector('pre .hljs-keyword')?.textContent).toBe('import');

		fireEvent.click(screen.getByRole('button', { name: /summary\.csv/ }));
		expect(within(canvas()).getByRole('columnheader', { name: 'Standard error' })).toBeTruthy();
		fireEvent.click(within(canvas()).getByRole('button', { name: 'Source' }));
		expect(canvas().querySelector('pre')?.textContent).toContain('n,standard_error');

		fireEvent.click(screen.getByRole('button', { name: /method-notes\.md/ }));
		expect(canvas().textContent).toContain('Quadrupling the sample halves the standard error.');
	});

	it('shows Save to workspace and the dialog of each answer the server can give (CNV-6)', async () => {
		renderPage();
		const canvas = () => screen.getByRole('complementary', { name: 'Canvas' });
		const press = async () => {
			fireEvent.pointerDown(within(canvas()).getByRole('button', { name: 'Copy' }), {
				button: 0,
				pointerType: 'mouse'
			});
			fireEvent.click(await screen.findByRole('menuitem', { name: 'Save to workspace' }));
			return screen.findByRole('alertdialog');
		};
		const first = await press();
		expect(first.textContent).toContain('Replace the workspace file?');
		expect(first.textContent).toContain('Replace it with this version?');
		fireEvent.click(within(first).getByRole('button', { name: 'Cancel' }));
		const second = await press();
		expect(second.textContent).toContain('Create the workspace file?');
		fireEvent.click(within(second).getByRole('button', { name: 'Create' }));
		expect(
			await screen.findByText('Saved to the workspace. The model sees it the next time it reads the file.')
		).toBeTruthy();
	});

	it('compares a text document with its earlier version in Changes, read-only (CNV-9)', () => {
		renderPage();
		const canvas = () => screen.getByRole('complementary', { name: 'Canvas' });
		fireEvent.click(screen.getByRole('button', { name: /method-notes\.md/ }));
		fireEvent.click(within(canvas()).getByRole('button', { name: 'Changes' }));
		const rows = within(canvas()).getByRole('region', { name: /Changes from version 1 to version 2/ });
		expect(rows.textContent).toContain('Added: - Quadrupling the sample halves the standard error.');
		expect(rows.textContent).toContain('Removed: - Doubling the sample shrinks the standard error.');
		expect(within(canvas()).getByRole('status').textContent).toMatch(/lines? added, \d+ removed/);
		expect(within(canvas()).queryByRole('button', { name: 'Edit document' })).toBeNull();
		fireEvent.click(within(canvas()).getByRole('button', { name: 'Source' }));
		expect(within(canvas()).getByRole('button', { name: 'Edit document' })).toBeTruthy();
	});

	it('edits a text document on request and will not close over unsaved changes', () => {
		renderPage();
		const canvas = () => screen.getByRole('complementary', { name: 'Canvas' });
		fireEvent.click(screen.getByRole('button', { name: /method-notes\.md/ }));
		expect(within(canvas()).getByText('All changes saved')).toBeTruthy();
		fireEvent.click(within(canvas()).getByRole('button', { name: 'Edit document' }));
		const editor = within(canvas()).getByLabelText('Edit method-notes.md');
		expect(within(canvas()).getByText('Editing. No changes yet')).toBeTruthy();
		// The editor is the source view with a caret: same text, highlighted, under the textarea.
		expect(canvas().querySelector('pre')?.textContent).toContain('## Method notes');
		expect(canvas().querySelector('pre .hljs-section')).toBeTruthy();
		fireEvent.change(editor, { target: { value: '## Changed heading' } });
		expect(canvas().querySelector('pre .hljs-section')?.textContent).toBe('## Changed heading');
		expect(within(canvas()).getByText('Unsaved changes')).toBeTruthy();

		expect(document.activeElement).toBe(editor);

		// Closing, or opening another document, asks first while changes are unsaved (CNV-6).
		fireEvent.click(within(canvas()).getByRole('button', { name: 'Close the canvas' }));
		let ask = screen.getByRole('alertdialog');
		expect(within(ask).getByText('Discard changes to method-notes.md?')).toBeTruthy();
		fireEvent.click(within(ask).getByRole('button', { name: 'Keep editing' }));
		expect(within(canvas()).getByLabelText('Edit method-notes.md')).toBeTruthy();

		fireEvent.click(within(canvas()).getByRole('button', { name: 'Save document' }));
		expect(canvas().textContent).toContain('Changed heading');
		expect(within(canvas()).getByText('All changes saved')).toBeTruthy();

		// Discarding through the question opens what was asked for.
		fireEvent.click(within(canvas()).getByRole('button', { name: 'Edit document' }));
		fireEvent.change(within(canvas()).getByLabelText('Edit method-notes.md'), { target: { value: 'scrap' } });
		fireEvent.click(screen.getByRole('button', { name: /fit\.py/ }));
		ask = screen.getByRole('alertdialog');
		fireEvent.click(within(ask).getByRole('button', { name: 'Discard changes' }));
		expect(canvas().querySelector('pre')?.textContent).toContain('def standard_error');

		fireEvent.click(within(canvas()).getByRole('button', { name: 'Edit document' }));
		fireEvent.click(within(canvas()).getByRole('button', { name: 'Discard changes' }));
		fireEvent.keyDown(canvas(), { key: 'Escape' });
		expect(screen.queryByRole('complementary', { name: 'Canvas' })).toBeNull();
		expect(screen.getByText(/The canvas is closed/)).toBeTruthy();
	});

	it('edits a page with its preview beside the source, updated on request, and only tries a block (CNV-5, CNV-6)', () => {
		renderPage();
		const canvas = () => screen.getByRole('complementary', { name: 'Canvas' });
		fireEvent.click(within(canvas()).getByRole('button', { name: 'Edit document' }));
		const editor = within(canvas()).getByLabelText('Edit Standard error explorer');
		const frame = () => within(canvas()).getByTitle('Preview of Standard error explorer');
		expect(frame().getAttribute('sandbox')).toBe('allow-scripts');
		expect(frame().getAttribute('srcdoc')).toContain('Standard error explorer');
		fireEvent.change(editor, { target: { value: '<p>draft</p>' } });
		expect(within(canvas()).getByText('Out of date')).toBeTruthy();
		expect(frame().getAttribute('srcdoc')).not.toContain('draft');
		fireEvent.click(within(canvas()).getByRole('button', { name: 'Update preview' }));
		expect(frame().getAttribute('srcdoc')).toContain('<p>draft</p>');
		expect(within(canvas()).queryByText('Out of date')).toBeNull();
		fireEvent.click(within(canvas()).getByRole('button', { name: 'Discard changes' }));

		fireEvent.click(screen.getByRole('button', { name: /Greeting page/ }));
		fireEvent.click(within(canvas()).getByRole('button', { name: 'Try changes' }));
		expect(within(canvas()).getByText('Changes to a code block are not saved. Copy or download them.')).toBeTruthy();
		expect(within(canvas()).queryByRole('button', { name: 'Save document' })).toBeNull();
	});

	it('marks the open row, and names the picture button', () => {
		renderPage();
		const first = screen.getByRole('button', { name: /demo-a All layers/ });
		const second = screen.getByRole('button', { name: /demo-b 20 layers/ });
		expect(first.getAttribute('aria-current')).toBe('true');
		fireEvent.click(second);
		expect(second.getAttribute('aria-current')).toBe('true');
		expect(first.getAttribute('aria-current')).toBeNull();
		fireEvent.click(screen.getByRole('button', { name: 'Change the profile picture' }));
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
