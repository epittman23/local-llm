import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { toast } from 'sonner';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
	ChartDemo,
	ConnectionUrlDemo,
	DisclosureDemo,
	OpeningTableDemo,
	StatusNoticeDemo,
	TallDialogDemo
} from './adminDemos';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

describe('the Admin demos on /ui', () => {
	it('shows a section state in each of its four tones, with Check again and Details on the warning', () => {
		render(<StatusNoticeDemo />);
		const notices = screen.getAllByRole('status');
		expect(notices.map((n) => n.getAttribute('data-tone'))).toEqual(['success', 'pending', 'warning', 'danger']);
		const warning = notices[2];
		expect(within(warning).getByText('The sandbox is not ready')).toBeTruthy();
		expect(within(warning).getByText('Details')).toBeTruthy();
		fireEvent.click(within(warning).getByRole('button', { name: 'Check again' }));
		expect(toast.success).toHaveBeenCalledWith('Checked again');
	});

	it('shows a folded group closed and one open, each named by its title', () => {
		render(<DisclosureDemo />);
		const closed = screen.getByRole('button', { name: 'Sign-in with an identity provider' });
		const open = screen.getByRole('button', { name: 'Default interface settings' });
		expect(closed).toHaveAttribute('aria-expanded', 'false');
		expect(open).toHaveAttribute('aria-expanded', 'true');
		expect(open).toHaveAccessibleDescription(
			'What every account starts from. A personal setting overrides its default. 1 changed'
		);
		expect(screen.getByRole('switch', { name: 'Widescreen mode' })).toBeChecked();
		fireEvent.click(closed);
		expect(screen.getByText('Set by environment variables.')).toBeTruthy();
	});

	it('tests a URL: reachable, refused, and not a URL at all', async () => {
		render(<ConnectionUrlDemo />);
		const [okTest, deadTest] = screen.getAllByRole('button', { name: 'Test connection' });
		fireEvent.click(okTest);
		expect(await screen.findByText('Reachable: 3 models')).toBeTruthy();
		fireEvent.click(deadTest);
		const dead = screen.getByLabelText('URL (nothing listening)');
		await waitFor(() => expect(dead).toHaveAttribute('aria-invalid', 'true'));
		expect(dead).toHaveAccessibleDescription('Connection refused at 127.0.0.1:9.');
		const bad = screen.getByLabelText('URL (not a URL)');
		expect(bad.getAttribute('aria-invalid')).toBeNull();
		fireEvent.blur(bad);
		expect(bad).toHaveAttribute('aria-invalid', 'true');
		expect(bad).toHaveAccessibleDescription('Enter a URL that starts with http:// or https://.');
		fireEvent.change(bad, { target: { value: 'http://demo-a.local' } });
		expect(bad.getAttribute('aria-invalid')).toBeNull();
	});

	it('sorts by a heading and opens a row from a cell or from its name', () => {
		render(<OpeningTableDemo />);
		const names = () =>
			screen
				.getAllByRole('row')
				.slice(1)
				.map((r) => within(r).getAllByRole('cell')[0].textContent);
		expect(names()).toEqual(['Statistics tutor', 'Code reviewer', 'Draft explainer']);
		expect(screen.getByRole('columnheader', { name: /Won/ })).toHaveAttribute('aria-sort', 'descending');
		fireEvent.click(screen.getByRole('button', { name: /^Model/ }));
		expect(screen.getByRole('columnheader', { name: /Model/ })).toHaveAttribute('aria-sort', 'descending');
		expect(screen.getByRole('columnheader', { name: /Won/ })).not.toHaveAttribute('aria-sort');
		expect(names()).toEqual(['Statistics tutor', 'Draft explainer', 'Code reviewer']);
		fireEvent.click(screen.getByText('18'));
		expect(toast.success).toHaveBeenLastCalledWith('Opened “Statistics tutor”');
		vi.mocked(toast.success).mockClear();
		fireEvent.click(screen.getByRole('button', { name: 'Code reviewer' }));
		expect(toast.success).toHaveBeenCalledTimes(1);
	});

	it('keeps a tall dialog’s fields in its scrolling body, between its title and buttons', () => {
		render(<TallDialogDemo />);
		fireEvent.click(screen.getByRole('button', { name: 'Edit connection' }));
		const dialog = screen.getByRole('dialog', { name: 'Edit connection' });
		const body = dialog.querySelector('[data-slot="dialog-body"]') as HTMLElement;
		expect(within(body).getByLabelText('URL')).toBeTruthy();
		expect(within(body).getByLabelText(/Headers/)).toBeTruthy();
		expect(within(body).queryByRole('button', { name: 'Save connection' })).toBeNull();
		expect(within(dialog).getByRole('button', { name: 'Save connection' })).toBeTruthy();
	});

	it('draws a chart with a legend and gives its values as a table', () => {
		render(
			<TooltipProvider>
				<ChartDemo />
			</TooltipProvider>
		);
		expect(screen.getAllByText('Statistics tutor').length).toBeGreaterThan(0);
		expect(screen.getAllByText('Code reviewer').length).toBeGreaterThan(0);
		fireEvent.click(screen.getByRole('button', { name: /Show as table/ }));
		expect(screen.getByRole('table')).toBeTruthy();
		expect(screen.getAllByRole('row').length).toBeGreaterThan(7);
	});
});
