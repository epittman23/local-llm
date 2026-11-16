import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HighlightDemo, TimeGridDemo, WeekdayTogglesDemo } from './notesDemos';

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
		expect(standup.style.height).toBe('23px');
		expect(standup.style.width).toBe('calc(100% - 4px)');
		expect(document.querySelector('[data-now]')).not.toBeNull();
	});
});
