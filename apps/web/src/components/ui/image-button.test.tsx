import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ImageButton } from './image-button';

describe('ImageButton (ACT-8, WCAG 2.5.3)', () => {
	it('is named by its aria-label alone: the initials drawn in the picture are hidden', () => {
		render(
			<ImageButton aria-label="Upload a picture" overlay={<svg />}>
				<span>ST</span>
			</ImageButton>
		);
		const button = screen.getByRole('button', { name: 'Upload a picture' });
		expect(screen.getByText('ST').closest('[aria-hidden]')).not.toBeNull();
		expect(button).toHaveAccessibleName('Upload a picture');
	});
});
