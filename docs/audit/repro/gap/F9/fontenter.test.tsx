// Repro F9: Interface tab -- a font typed and submitted with Enter is not saved, yet the toast says saved.
import { QueryProvider } from '@/lib/query/QueryProvider';
import { fireEvent, render, screen, waitFor } from '../../../../../apps/web/node_modules/@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Interface from '@/components/settings/personal/Interface';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';

afterEach(() => vi.unstubAllGlobals());

const setup = () => {
	useAuthStore.setState({
		token: 'jwt',
		status: 'authenticated',
		user: { id: 'u1', email: 'a@b', name: 'A', role: 'user', profile_image_url: '', permissions: {} }
	} as never);
	useConfigStore.setState({ config: { name: 'x', version: '1', features: {} } } as never);
	const posts: any[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init: RequestInit = {}) => {
			const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { 'Content-Type': 'application/json' } });
			if (String(url).includes('/users/user/settings/update')) {
				const body = JSON.parse(String(init.body));
				posts.push(body);
				return json(body);
			}
			if (String(url).includes('/users/user/settings')) return json({ ui: { chatBubble: true } });
			return json({});
		})
	);
	render(
		<QueryProvider>
			<TooltipProvider>
				<Interface />
			</TooltipProvider>
		</QueryProvider>
	);
	return posts;
};

describe('Interface font family', () => {
	it('Enter in the font box saves without the font', async () => {
		const posts = setup();
		fireEvent.click(await screen.findByRole('button', { name: 'Font Family: Default' }));
		const box = screen.getByLabelText('Font Family name');
		fireEvent.change(box, { target: { value: 'Aptos' } });
		// Enter in a text field = implicit submission of the tab's <form> (no blur happens).
		fireEvent.submit(box.closest('form')!);
		await waitFor(() => expect(posts.length).toBe(1));
		console.log('ENTER save body fontFamily:', JSON.stringify(posts[0].ui.fontFamily));
		console.log('applied CSS var:', document.documentElement.style.getPropertyValue('--app-font-family'));
		expect(posts[0].ui.fontFamily).toBeUndefined();
	});
	it('control: blur then Save does include it', async () => {
		const posts = setup();
		fireEvent.click(await screen.findByRole('button', { name: 'Font Family: Default' }));
		const box = screen.getByLabelText('Font Family name');
		fireEvent.change(box, { target: { value: 'Aptos' } });
		fireEvent.blur(box);
		fireEvent.submit(box.closest('form')!);
		await waitFor(() => expect(posts.length).toBe(1));
		console.log('BLUR save body fontFamily:', JSON.stringify(posts[0].ui.fontFamily));
		expect(posts[0].ui.fontFamily).toBe('Aptos');
	});
});
