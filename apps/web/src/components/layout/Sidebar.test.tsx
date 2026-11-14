import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/lib/stores/authStore';
import { useUIStore } from '@/lib/stores/uiStore';
import { SidebarContent } from './Sidebar';

vi.mock('@/routes/chat/sidebar/ChatSidebar', () => ({ ChatSidebar: () => <div /> }));
vi.mock('@/routes/channels/SidebarChannels', () => ({ SidebarChannels: () => <div /> }));

beforeEach(() => {
	useAuthStore.setState({
		status: 'authenticated',
		token: 't',
		user: { id: 'u1', name: 'Ada', role: 'user' }
	} as never);
	useUIStore.setState({ searchOpen: false } as never);
});
afterEach(cleanup);

describe('SidebarContent Search', () => {
	it('opens the chat search when the Search button is pressed', () => {
		render(
			<MemoryRouter>
				<SidebarContent />
			</MemoryRouter>
		);
		expect(useUIStore.getState().searchOpen).toBe(false);
		fireEvent.click(screen.getByRole('button', { name: 'Search' }));
		expect(useUIStore.getState().searchOpen).toBe(true);
	});
});
