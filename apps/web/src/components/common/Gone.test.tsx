import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button } from '@/components/ui/button';
import { Gone, isNotFound, NOT_FOUND_DETAIL } from './Gone';

describe('Gone (NAV-3)', () => {
	it('says what is gone as the page heading, why it might be, and offers ways onward', () => {
		render(
			<Gone
				title="This chat no longer exists."
				description="It may have been deleted or archived."
				actions={<Button>New chat</Button>}
			/>
		);
		const panel = screen.getByRole('region', { name: 'This chat no longer exists.' });
		expect(screen.getByRole('heading', { level: 1, name: 'This chat no longer exists.' })).toHaveClass(
			'text-heading',
			'font-title'
		);
		expect(panel).toHaveTextContent('It may have been deleted or archived.');
		expect(screen.getByRole('button', { name: 'New chat' })).toBeInTheDocument();
	});

	it('is an h2 where the page has its h1 already, with no description or actions', () => {
		render(<Gone title="This folder no longer exists." level={2} />);
		expect(screen.getByRole('heading', { level: 2, name: 'This folder no longer exists.' })).toBeInTheDocument();
		expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
		expect(screen.queryByRole('button')).toBeNull();
	});

	it('takes a deeper heading level inside a page’s own section', () => {
		render(<Gone title="This note no longer exists." level={4} />);
		expect(screen.getByRole('heading', { level: 4, name: 'This note no longer exists.' })).toBeInTheDocument();
	});

	it('tells the server’s not-found answer from any other failure', () => {
		expect(isNotFound(NOT_FOUND_DETAIL)).toBe(true);
		expect(isNotFound('Database is locked')).toBe(false);
		expect(isNotFound(new TypeError('Failed to fetch'))).toBe(false);
	});
});
