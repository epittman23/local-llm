import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { DayGridDemo, HighlightDemo, TimeGridDemo, ToolbarDemo, WeekdayTogglesDemo } from './notesDemos';

describe('/ui section 6 demos', () => {
	it('shows a highlight as a mark inside rendered text (CNT-1)', () => {
		render(<HighlightDemo />);
		const mark = screen.getByText(/its variance falls/);
		expect(mark.tagName).toBe('MARK');
		expect(mark.closest('.rich-text')).not.toBeNull();
	});

	it('shows weekday toggles: pressed ones in the brand fill, and a press toggles one (COL-4)', () => {
		render(<WeekdayTogglesDemo />);
		const buttons = screen.getAllByRole('button');
		expect(buttons).toHaveLength(7);
		const [mon, tue] = buttons;
		expect(mon).toHaveAttribute('aria-pressed', 'true');
		expect(mon).toHaveAttribute('data-variant', 'default');
		expect(tue).toHaveAttribute('aria-pressed', 'false');
		expect(tue).toHaveAttribute('data-variant', 'outline');
		fireEvent.click(tue);
		expect(tue).toHaveAttribute('aria-pressed', 'true');
		fireEvent.click(mon);
		expect(mon).toHaveAttribute('aria-pressed', 'false');
	});

	it('lays out a time grid with layoutDay: overlaps side by side, a short block at its least height, a now-line (DAT-7)', () => {
		render(<TimeGridDemo />);
		expect(screen.getByRole('img', { name: /A morning on the time grid/ })).toBeInTheDocument();
		const blocks = [...document.querySelectorAll<HTMLElement>('[data-block]')];
		expect(blocks).toHaveLength(3);
		const [reading, review, standup] = blocks;
		// 9:00 to 10:30 from 8 AM at 48 px an hour.
		expect(reading.style.top).toBe('48px');
		expect(reading.style.height).toBe('71px');
		expect(reading.style.width).toBe('calc(50% - 4px)');
		expect(review.style.left).toBe('calc(50% + 2px)');
		// A quarter of an hour is drawn at the 24 px floor.
		expect(standup.style.height).toBe('24px');
		expect(standup.style.width).toBe('calc(100% - 4px)');
		expect(document.querySelector('[data-now]')).not.toBeNull();
	});

	it('shows a toolbar as one tab stop: arrows, Home and End move, Escape returns to the text (NAV-5)', () => {
		render(
			<TooltipProvider>
				<ToolbarDemo />
			</TooltipProvider>
		);
		const tools = screen.getAllByRole('button');
		const tabbable = () => tools.filter((t) => t.tabIndex === 0).map((t) => t.getAttribute('aria-label'));
		expect(screen.getByRole('toolbar', { name: 'Formatting' })).toBeInTheDocument();
		expect(tabbable()).toEqual(['Bold']);
		tools[0].focus();
		fireEvent.keyDown(tools[0], { key: 'ArrowRight' });
		expect(document.activeElement).toBe(tools[1]);
		expect(tabbable()).toEqual(['Italic']);
		fireEvent.keyDown(tools[1], { key: 'End' });
		expect(document.activeElement).toBe(tools[4]);
		fireEvent.keyDown(tools[4], { key: 'ArrowRight' });
		expect(document.activeElement).toBe(tools[0]);
		fireEvent.keyDown(tools[0], { key: 'ArrowLeft' });
		expect(document.activeElement).toBe(tools[4]);
		fireEvent.keyDown(tools[4], { key: 'Home' });
		expect(document.activeElement).toBe(tools[0]);
		fireEvent.keyDown(tools[0], { key: 'a' });
		expect(document.activeElement).toBe(tools[0]);
		fireEvent.click(tools[1]);
		expect(tools[1]).toHaveAttribute('aria-pressed', 'true');
		fireEvent.keyDown(tools[0], { key: 'Escape' });
		expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Sample text' }));
	});

	it('shows a grid of days as one tab stop that pages the month at its edge (NAV-5)', async () => {
		render(<DayGridDemo />);
		const day = (label: RegExp) => screen.getByRole('button', { name: label });
		const tabbable = () => screen.getAllByRole('button').filter((b) => b.tabIndex === 0);
		expect(tabbable()).toEqual([day(/^16 November 2026/)]);
		day(/^16 November 2026/).focus();
		fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' });
		await waitFor(() => expect(document.activeElement).toBe(day(/^23 November 2026/)));
		fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowRight' });
		await waitFor(() => expect(document.activeElement).toBe(day(/^24 November 2026/)));
		// The grid ends on 12 December: a week down from the 8th pages to December.
		expect(screen.getByText('November 2026')).toBeInTheDocument();
		const down = () => fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' });
		down();
		down();
		down();
		await waitFor(() => expect(document.activeElement).toBe(day(/^15 December 2026/)));
		expect(screen.getByText('December 2026')).toBeInTheDocument();
		fireEvent.click(document.activeElement as Element);
		expect(day(/^15 December 2026/)).toHaveAttribute('aria-current', 'true');
	});
});
