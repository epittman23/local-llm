import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button } from './button';

describe('Button focus (A11Y-1)', () => {
	it('draws no border or ring of its own on focus: only the keyboard outline in standard.css shows focus', () => {
		render(
			<>
				<Button>Save</Button>
				<Button variant="destructive">Delete</Button>
			</>
		);
		for (const name of ['Save', 'Delete']) {
			expect(screen.getByRole('button', { name }).className).not.toMatch(/focus-visible:(border|ring)/);
		}
	});
});
