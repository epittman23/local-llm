import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PageHeader } from './page-header';

afterEach(cleanup);

describe('PageHeader (LAY-5)', () => {
	it('opens with an h1 naming the page, one sentence on what it is for, and its action', () => {
		render(
			<PageHeader
				title="Workspace"
				description="The models, knowledge, prompts, skills and tools your chats draw on."
				action={<button type="button">Create</button>}
			/>
		);
		const heading = screen.getByRole('heading', { level: 1, name: 'Workspace' });
		expect(heading.className).toContain('text-heading');
		expect(screen.getByText(/your chats draw on/)).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument();
		// On a phone, toasts and the connection banner start below a page's header (FBK-2).
		expect(heading.closest('[data-page-top]')).not.toBeNull();
	});

	it('takes a lower heading level where it sits inside another page', () => {
		render(<PageHeader as="h4" title="Knowledge" description="Collections of files." />);
		expect(screen.getByRole('heading', { level: 4, name: 'Knowledge' })).toBeInTheDocument();
		expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
		// Nested inside another page (/ui), it is not that page's top.
		expect(document.querySelector('[data-page-top]')).toBeNull();
	});

	it('shows a count as a secondary badge after the title, outside the heading, with its noun for a screen reader', () => {
		render(<PageHeader title="Automations" description="Runs on a schedule." count={{ value: 1234, noun: 'automations' }} />);
		const heading = screen.getByRole('heading', { level: 1, name: 'Automations' });
		const badge = heading.nextElementSibling as HTMLElement;
		expect(badge).toHaveAttribute('data-slot', 'badge');
		expect(badge).toHaveAttribute('data-variant', 'secondary');
		expect(badge).toHaveTextContent('1,234 automations');
		expect(badge.querySelector('.sr-only')).toHaveTextContent('automations');
	});

	it('shows no badge without a count', () => {
		render(<PageHeader title="Automations" description="Runs on a schedule." />);
		expect(document.querySelector('[data-slot="badge"]')).toBeNull();
	});
});
