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
	});

	it('takes a lower heading level where it sits inside another page', () => {
		render(<PageHeader as="h4" title="Knowledge" description="Collections of files." />);
		expect(screen.getByRole('heading', { level: 4, name: 'Knowledge' })).toBeInTheDocument();
		expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
	});
});
