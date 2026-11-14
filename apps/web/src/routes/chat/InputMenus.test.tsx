// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AttachMenu, IntegrationsMenu } from './InputMenus';

vi.mock('@/lib/apis/knowledge', () => ({
	searchKnowledgeBases: vi.fn(async () => ({ items: [{ id: 'kb1', name: 'Handbook' }] })),
	searchKnowledgeFiles: vi.fn(async () => ({ items: [] }))
}));
vi.mock('@/lib/apis/notes', () => ({ searchNotes: vi.fn(async () => ({ items: [] })) }));
vi.mock('@/lib/apis/chats', () => ({ getChatListBySearchText: vi.fn(async () => []) }));
vi.mock('@/lib/stores/authStore', () => ({
	useAuthStore: (sel: (s: unknown) => unknown) => sel({ token: 't', user: { id: 'u1' } })
}));

const wrap = (ui: React.ReactNode) =>
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<TooltipProvider>{ui}</TooltipProvider>
		</QueryClientProvider>
	);

const openMenu = (name: string) => fireEvent.keyDown(screen.getByRole('button', { name }), { key: 'Enter' });

afterEach(cleanup);

describe('AttachMenu knowledge picker', () => {
	it('lists the matching knowledge bases and attaches the one pressed', async () => {
		const onItem = vi.fn();
		wrap(<AttachMenu onFiles={vi.fn()} onWeb={vi.fn()} onItem={onItem} canUpload canWeb notesEnabled={false} />);
		openMenu('More');
		fireEvent.click(await screen.findByRole('menuitem', { name: /Attach Knowledge/ }));
		const option = await screen.findByRole('option', { name: /Handbook/ });
		fireEvent.click(option);
		expect(onItem).toHaveBeenCalledWith(expect.objectContaining({ id: 'kb1', type: 'collection' }));
		await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
	});

	it('says so when nothing matches', async () => {
		wrap(<AttachMenu onFiles={vi.fn()} onWeb={vi.fn()} onItem={vi.fn()} canUpload canWeb notesEnabled />);
		openMenu('More');
		fireEvent.click(await screen.findByRole('menuitem', { name: /Reference Chats/ }));
		expect(await screen.findByText('No results found')).toBeTruthy();
		expect(screen.queryByRole('option')).toBeNull();
	});
});

describe('IntegrationsMenu', () => {
	const props = {
		tools: [],
		toolIds: [],
		onToolIds: vi.fn(),
		buttons: { webSearch: true, imageGeneration: false, codeInterpreter: false },
		toggles: { webSearch: true, imageGeneration: false, codeInterpreter: false }
	};

	it('shows a button for each feature that is on, which turns it off', () => {
		const onToggles = vi.fn();
		wrap(<IntegrationsMenu {...props} onToggles={onToggles} />);
		fireEvent.click(screen.getByRole('button', { name: 'Web Search (on)' }));
		expect(onToggles).toHaveBeenCalledExactlyOnceWith({
			webSearch: false,
			imageGeneration: false,
			codeInterpreter: false
		});
	});

	it('shows no such button for a feature that is off', () => {
		wrap(<IntegrationsMenu {...props} toggles={{ ...props.toggles, webSearch: false }} onToggles={vi.fn()} />);
		expect(screen.queryByRole('button', { name: 'Web Search (on)' })).toBeNull();
		expect(screen.getByRole('button', { name: 'Integrations' })).toBeTruthy();
	});

	it('counts the enabled tools on the Integrations button', () => {
		wrap(<IntegrationsMenu {...props} tools={[{ id: 't1', name: 'Calc' }]} toolIds={['t1']} onToggles={vi.fn()} />);
		expect(screen.getByRole('button', { name: 'Integrations' }).textContent).toBe('1');
	});
});
