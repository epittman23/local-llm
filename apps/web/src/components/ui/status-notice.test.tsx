import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusNotice } from './status-notice';

describe('StatusNotice', () => {
	it('says its state in words, in its status colour, with an icon (COL-3)', () => {
		render(<StatusNotice tone="warning" title="The sandbox isn't ready" />);
		const notice = screen.getByRole('status');
		expect(notice.getAttribute('data-tone')).toBe('warning');
		expect(screen.getByText("The sandbox isn't ready").className).toContain('text-warning');
		expect(notice.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
	});

	it('shows what it means, an action, and the technical words behind Details (FBK-4)', () => {
		render(
			<StatusNotice tone="danger" title="Couldn't check" details="HTTP 500" action={<button type="button">Check again</button>}>
				<p>The server did not answer.</p>
			</StatusNotice>
		);
		expect(screen.getByText('The server did not answer.')).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy();
		expect(screen.getByText('Details').tagName).toBe('SUMMARY');
		expect(screen.getByText('HTTP 500')).toBeTruthy();
	});

	it('spins only while pending, and has no Details without details', () => {
		const { rerender } = render(<StatusNotice tone="pending" title="Checking…" />);
		expect(screen.getByRole('status').querySelector('svg')?.getAttribute('class')).toContain('animate-spin');
		rerender(<StatusNotice tone="success" title="Ready" />);
		expect(screen.getByRole('status').querySelector('svg')?.getAttribute('class')).not.toContain('animate-spin');
		expect(screen.queryByText('Details')).toBeNull();
	});
});
