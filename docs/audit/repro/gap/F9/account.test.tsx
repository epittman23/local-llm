// Repro F9: Account tab -- a failed load turns Save into an overwrite.
import { fireEvent, render, screen, waitFor } from '../../../../../apps/web/node_modules/@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Account from '@/components/settings/personal/Account';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';

type Call = { url: string; method: string; body: any };
let calls: Call[] = [];

function mockFetch(failLoads: boolean) {
	calls = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init: RequestInit = {}) => {
			const method = init.method ?? 'GET';
			const body = init.body ? JSON.parse(String(init.body)) : undefined;
			calls.push({ url: String(url), method, body });
			const json = (status: number, data: unknown) =>
				new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
			if (method === 'GET' && String(url).endsWith('/auths/'))
				return failLoads
					? json(500, { detail: 'temporary failure' })
					: json(200, {
							id: 'u1',
							name: 'Ann',
							profile_image_url: 'data:image/png;base64,AAAA',
							bio: 'my bio',
							gender: 'female',
							date_of_birth: '1990-01-02'
						});
			if (method === 'GET' && String(url).endsWith('/users/user/variables'))
				return failLoads ? json(500, { detail: 'temporary failure' }) : json(200, { variables: { team: 'a' } });
			if (String(url).endsWith('/auths/update/profile')) return json(200, { id: 'u1', ...body });
			if (String(url).endsWith('/users/user/variables/update')) return json(200, { variables: body.variables });
			return json(404, { detail: 'nope' });
		})
	);
}

beforeEach(() => {
	// The session as the sign-in response leaves it (auths.py:195-205): no bio/gender/dob,
	// profile_image_url is the image route.
	useAuthStore.setState({
		token: 'jwt',
		status: 'authenticated',
		user: {
			id: 'u1',
			email: 'a@b',
			name: 'Ann',
			role: 'user',
			profile_image_url: '/api/v1/users/u1/profile/image',
			permissions: {}
		}
	} as never);
	useConfigStore.setState({ config: { name: 'x', version: '1', features: {} } } as never);
});
afterEach(() => vi.unstubAllGlobals());

describe('Account save after a failed load', () => {
	it('control: loads succeed -> Save sends the loaded values', async () => {
		mockFetch(false);
		render(<Account />);
		await screen.findByDisplayValue('my bio');
		fireEvent.click(screen.getByRole('button', { name: /Save/ }));
		await waitFor(() => expect(calls.some((c) => c.url.endsWith('/variables/update'))).toBe(true));
		const profile = calls.find((c) => c.url.endsWith('/update/profile'))!.body;
		const vars = calls.find((c) => c.url.endsWith('/variables/update'))!.body;
		console.log('CONTROL profile body:', JSON.stringify(profile));
		console.log('CONTROL variables body:', JSON.stringify(vars));
	});

	it('loads fail (500) -> no error shown, Save wipes variables and profile fields', async () => {
		mockFetch(true);
		render(<Account />);
		await screen.findByLabelText('Name');
		expect(screen.getByText('No user variables configured.')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: /Save/ }));
		await waitFor(() => expect(calls.some((c) => c.url.endsWith('/variables/update'))).toBe(true));
		const profile = calls.find((c) => c.url.endsWith('/update/profile'))!.body;
		const vars = calls.find((c) => c.url.endsWith('/variables/update'))!.body;
		console.log('FAILED-LOAD profile body:', JSON.stringify(profile));
		console.log('FAILED-LOAD variables body:', JSON.stringify(vars));
		expect(vars).toEqual({ variables: {} });
		expect(profile).toMatchObject({
			bio: null,
			gender: null,
			date_of_birth: null,
			profile_image_url: '/api/v1/users/u1/profile/image'
		});
	});

	it('Enter in a password box submits the profile Save, not the password change', async () => {
		mockFetch(false);
		useConfigStore.setState({
			config: { name: 'x', version: '1', features: { enable_login_form: true, enable_password_change_form: true } }
		} as never);
		render(<Account />);
		await screen.findByDisplayValue('my bio');
		const confirm = screen.getByLabelText('Confirm Password');
		fireEvent.change(screen.getByLabelText('Current Password'), { target: { value: 'old' } });
		fireEvent.change(screen.getByLabelText('New Password'), { target: { value: 'new' } });
		fireEvent.change(confirm, { target: { value: 'new' } });
		// Implicit submission: what the browser does on Enter in a text field of a form with a submit button.
		fireEvent.submit(confirm.closest('form')!);
		await waitFor(() => expect(calls.some((c) => c.url.endsWith('/update/profile'))).toBe(true));
		console.log(
			'ENTER-IN-PASSWORD requests:',
			calls.filter((c) => c.method === 'POST').map((c) => c.url.replace(/.*\/api\/v1/, ''))
		);
		expect(calls.some((c) => c.url.endsWith('/update/password'))).toBe(false);
	});
});
