import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WEBUI_BASE_URL } from '@/lib/constants';
import { ProfileImageEditor } from './ProfileImageEditor';

const USER = { name: 'Ada Lovelace', email: 'ada@example.com' };

describe('ProfileImageEditor', () => {
	it('names the picture button with the initials it shows (WCAG 2.5.3)', () => {
		render(<ProfileImageEditor value={`${WEBUI_BASE_URL}/user.png`} user={USER} onChange={vi.fn()} />);
		expect(screen.getByRole('button', { name: 'AL, change picture' })).toHaveTextContent('AL');
	});

	it('names it plainly once the account has a picture of its own', () => {
		render(<ProfileImageEditor value="data:image/png;base64,AAAA" user={USER} onChange={vi.fn()} />);
		expect(screen.getByRole('button', { name: 'Change picture' })).toBeInTheDocument();
	});
});
