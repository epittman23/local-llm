import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { DataSection, FormsSection, NavigationSection, StatesSection, StatusBadge } from './components';

const inProvider = (node: React.ReactNode) => render(<TooltipProvider>{node}</TooltipProvider>);

describe('/ui components', () => {
	it.each([
		['success', 'Passed'],
		['warning', 'Throttled'],
		['danger', 'Failed']
	] as const)('shows the %s status as the shared Badge variant with an icon', (status, word) => {
		render(<StatusBadge status={status}>{word}</StatusBadge>);
		const badge = screen.getByText(word);
		expect(badge).toHaveAttribute('data-slot', 'badge');
		expect(badge).toHaveAttribute('data-variant', status);
		expect(badge.querySelector('svg[data-icon="inline-start"]')).not.toBeNull();
	});

	it('shows the neutral status as a secondary badge without an icon', () => {
		render(<StatusBadge status="neutral">Not run</StatusBadge>);
		const badge = screen.getByText('Not run');
		expect(badge).toHaveAttribute('data-variant', 'secondary');
		expect(badge.querySelector('svg')).toBeNull();
	});

	it('demonstrates the table as a named scrolling region (DAT-6)', () => {
		inProvider(<DataSection />);
		const region = screen.getByRole('region', { name: 'Runs' });
		expect(within(region).getByRole('table')).toBeInTheDocument();
	});

	it('demonstrates a native select beside the shared one (FRM-4)', () => {
		inProvider(<FormsSection />);
		const native = screen.getByRole('combobox', { name: 'Native select' });
		expect(native.tagName).toBe('SELECT');
		expect(screen.getByRole('combobox', { name: 'Shared Select, compact' }).tagName).toBe('BUTTON');
	});

	it('uses the shared save bar for the form that saves on request (FRM-3)', () => {
		inProvider(<FormsSection />);
		const bar = document.querySelector('[data-slot="save-bar"]') as HTMLElement;
		expect(within(bar).getByRole('status')).toHaveTextContent('All changes saved');
		expect(within(bar).getByRole('button', { name: 'Save profile' })).toBeDisabled();
		fireEvent.change(screen.getByLabelText('Profile name'), { target: { value: 'demo-b' } });
		expect(within(bar).getByRole('status')).toHaveTextContent('Unsaved changes');
		fireEvent.click(within(bar).getByRole('button', { name: 'Discard changes' }));
		expect(screen.getByLabelText('Profile name')).toHaveValue('demo-a');
	});

	it('picks a theme from a segmented control without changing the page (FRM-4)', () => {
		inProvider(<FormsSection />);
		const theme = screen.getByRole('radiogroup', { name: 'Theme' });
		expect(
			within(theme)
				.getAllByRole('radio')
				.map((r) => r.textContent)
		).toEqual(['System', 'Dark', 'Black', 'Light']);
		expect(within(theme).getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true');
		fireEvent.click(within(theme).getByRole('radio', { name: 'Light' }));
		expect(within(theme).getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true');
		expect(screen.getByText('Light. Applied.')).toBeInTheDocument();
		expect(document.documentElement.classList.contains('light')).toBe(false);
	});

	it('asks who can open a link with nothing chosen, and says why a segment is off (FRM-4, ACT-5)', () => {
		inProvider(<FormsSection />);
		const share = screen.getByRole('radiogroup', { name: 'Who can open the link' });
		expect(within(share).queryByRole('radio', { checked: true })).toBeNull();
		expect(within(share).getByRole('radio', { name: 'Anyone with the link' })).toBeDisabled();
		const help = document.getElementById(share.getAttribute('aria-describedby') ?? '');
		expect(help).toHaveTextContent('Your sharing permissions do not allow links that anyone can open.');
		const create = screen.getByRole('button', { name: 'Create and copy link' });
		expect(create).toBeDisabled();
		fireEvent.click(within(share).getByRole('radio', { name: 'Only me (signed in)' }));
		expect(create).toBeEnabled();
	});

	it('shows the mark at its three sizes, decorative beside the name (WRD-3)', () => {
		inProvider(<NavigationSection />);
		const marks = [...document.querySelectorAll('[data-slot="app-mark"]')];
		expect(marks.map((m) => m.getAttribute('class')?.match(/size-\d/)?.[0])).toEqual([
			'size-5',
			'size-6',
			'size-8',
			'size-6'
		]);
		for (const mark of marks) expect(mark).toHaveAttribute('aria-hidden', 'true');
		expect(screen.getByText('local-llm')).toBeInTheDocument();
	});

	it("demonstrates the model picker's two-line rows, checking the one chosen (NAV-5)", () => {
		inProvider(<NavigationSection />);
		const list = screen.getByText('Writes, reviews and debugs code.').closest('[role="listbox"]') as HTMLElement;
		const options = within(list).getAllByRole('option');
		expect(options.map((o) => o.textContent)).toEqual([
			expect.stringContaining('Writes, reviews and debugs code.'),
			expect.stringContaining('qwen/qwen3.6-27b')
		]);
		expect(within(options[1]).getByText('qwen/qwen3.6-27b')).toHaveClass('font-mono');
		expect(options[0].textContent).toContain('(current)');
		fireEvent.click(options[1]);
		expect(within(list).getAllByRole('option')[1].textContent).toContain('(current)');
		expect(within(list).getAllByRole('option')[0].textContent).not.toContain('(current)');
	});

	it('demonstrates the vertical tab list, which opens a tab on Enter and names a repeated one by its half (NAV-2)', () => {
		inProvider(<NavigationSection />);
		const list = screen.getByRole('tablist', { name: 'Settings' });
		const general = within(list).getByRole('tab', { name: 'General' });
		expect(general).toHaveAttribute('aria-selected', 'true');
		expect(screen.getByRole('tabpanel', { name: 'General' })).toHaveTextContent("The General tab's settings.");
		const server = within(list).getByRole('tab', { name: 'Server: General' });
		fireEvent.click(server);
		expect(server).toHaveAttribute('aria-selected', 'true');
		expect(screen.getByRole('tabpanel', { name: 'Server: General' })).toBeInTheDocument();
	});

	it('demonstrates a list chosen from by keyboard: the field keeps focus and the first item is highlighted (NAV-5)', () => {
		inProvider(<NavigationSection />);
		const field = screen.getByRole('combobox', { name: 'Search chats' });
		field.focus();
		expect(screen.getByRole('group', { name: 'Today' })).toBeInTheDocument();
		expect(screen.getByRole('group', { name: 'Previous 7 days' })).toBeInTheDocument();
		const [first, second] = screen.getAllByRole('option');
		expect(first).toHaveAttribute('aria-selected', 'true');
		fireEvent.keyDown(field, { key: 'ArrowDown' });
		expect(second).toHaveAttribute('aria-selected', 'true');
		expect(field).toHaveFocus();
		fireEvent.change(field, { target: { value: 'kiwi' } });
		expect(screen.getByText('No chats match. Check the spelling, or search archived chats.')).toBeInTheDocument();
	});

	it('demonstrates a missing thing said in place, under its example heading, with ways onward (NAV-3)', () => {
		inProvider(<StatesSection />);
		const gone = screen.getByRole('region', { name: 'This chat no longer exists.' });
		expect(within(gone).getByRole('heading', { level: 4 })).toHaveTextContent('This chat no longer exists.');
		expect(within(gone).getByRole('button', { name: 'New chat' })).toBeInTheDocument();
		expect(within(gone).getByRole('button', { name: 'Search chats' })).toBeInTheDocument();
	});
});
