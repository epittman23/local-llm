import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { useAuthStore } from '@/lib/stores/authStore';
import { HomePage } from './HomePage';

describe('HomePage', () => {
	it('titles the page on the standard’s heading step (TYP-2)', () => {
		useAuthStore.setState({ user: null } as never);
		render(
			<MemoryRouter>
				<HomePage />
			</MemoryRouter>
		);
		expect(screen.getByRole('heading', { level: 1, name: 'Home' }).className).toContain('text-heading');
	});
});
