import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as auths from '@/lib/apis/auths';
import * as users from '@/lib/apis/users';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import Account from './Account';

vi.mock('@/lib/apis/auths', async (original) => ({
	...(await original<typeof import('@/lib/apis/auths')>()),
	getSessionUser: vi.fn(),
	updateUserProfile: vi.fn()
}));
vi.mock('@/lib/apis/users', async (original) => ({
	...(await original<typeof import('@/lib/apis/users')>()),
	getUserVariables: vi.fn(),
	updateUserVariables: vi.fn()
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

describe('Account tab profile image buttons', () => {
	beforeEach(() => {
		useAuthStore.setState({ token: 'jwt', user: { id: 'u1', name: 'Ann', role: 'user' } } as never);
		useConfigStore.setState({ config: { name: 'x', version: '1', features: { enable_api_keys: false } } } as never);
		vi.mocked(auths.getSessionUser).mockResolvedValue({
			id: 'u1',
			name: 'Ann',
			profile_image_url: 'data:image/png;base64,AAAA',
			bio: 'my bio'
		} as never);
		vi.mocked(users.getUserVariables).mockResolvedValue({ variables: {} });
		vi.mocked(auths.updateUserProfile).mockImplementation(async (_t, body) => ({ id: 'u1', ...body }) as never);
		vi.mocked(users.updateUserVariables).mockImplementation(async (_t, variables) => ({ variables }));
	});
	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	it('opens the file chooser from Upload image', async () => {
		render(<Account />);
		await screen.findByDisplayValue('my bio');
		const click = vi.spyOn(screen.getByLabelText('Upload profile image') as HTMLInputElement, 'click');
		fireEvent.click(screen.getByRole('button', { name: 'Upload image' }));
		expect(click).toHaveBeenCalledTimes(1);
	});

	it('saves the default image after Remove is pressed', async () => {
		render(<Account />);
		await screen.findByDisplayValue('my bio');
		fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() =>
			expect(auths.updateUserProfile).toHaveBeenCalledWith(
				'jwt',
				expect.objectContaining({ profile_image_url: '/user.png' })
			)
		);
	});
});
