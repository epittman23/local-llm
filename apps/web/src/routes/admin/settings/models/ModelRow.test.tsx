import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { ModelItem } from './adminModels';
import { ModelRow, type RowHandlers } from './ModelRow';

const handlers = (): RowHandlers => ({
	open: vi.fn(),
	toggleActive: vi.fn(),
	toggleHidden: vi.fn(),
	toggleSelected: vi.fn(),
	toggleDefaultPinned: vi.fn(),
	togglePrivacy: vi.fn(),
	togglePinnedInSidebar: vi.fn(),
	copyLink: vi.fn(),
	clone: vi.fn(),
	exportModel: vi.fn(),
	moveUp: vi.fn(),
	moveDown: vi.fn()
});

const MODEL: ModelItem = { id: 'm1', name: 'Model One', is_active: true, meta: {}, access_grants: [] };

const renderRow = (over: Partial<Parameters<typeof ModelRow>[0]> = {}) => {
	const h = handlers();
	render(
		<TooltipProvider>
			<ModelRow
				model={MODEL}
				index={1}
				count={3}
				singleUser={false}
				pinsByDefault
				canReorder
				isSelected={false}
				isDefaultPinned={false}
				isSidebarPinned={false}
				dragging={false}
				dropTarget={false}
				handlers={h}
				onDragStart={vi.fn()}
				onDragOver={vi.fn()}
				onDrop={vi.fn()}
				onDragEnd={vi.fn()}
				{...over}
			/>
		</TooltipProvider>
	);
	return h;
};

const openMenu = async (name = 'Model One') => {
	fireEvent.keyDown(screen.getByRole('button', { name: `More actions for ${name}` }), { key: 'Enter' });
	return screen.findByRole('menu');
};

describe('ModelRow', () => {
	it('shows the name with its access label and the default and pinned badges', () => {
		renderRow({ isSelected: true, isDefaultPinned: true });
		expect(screen.getByText('Model One')).toBeTruthy();
		expect(screen.getByText('Private')).toBeTruthy();
		expect(screen.getByText('Default')).toBeTruthy();
		expect(screen.getByText('Pinned')).toBeTruthy();
	});

	it('labels a model with a public read grant as Public', () => {
		renderRow({
			model: { ...MODEL, access_grants: [{ principal_type: 'user', principal_id: '*', permission: 'read' }] }
		});
		expect(screen.getByText('Public')).toBeTruthy();
	});

	it('shows a hidden or off model as badges, not a dimmed row (DAT-3, COL-2)', () => {
		renderRow({ model: { ...MODEL, is_active: false, meta: { hidden: true } } });
		expect(screen.getByText('Hidden').closest('[data-slot=badge]')).toBeTruthy();
		expect(screen.getByText('Off').closest('[data-slot=badge]')).toBeTruthy();
		const row = document.querySelector('[data-model-row="m1"]') as HTMLElement;
		expect(row.className).not.toMatch(/opacity/);
		expect(row.querySelector('[data-slot=row-button]')?.innerHTML).not.toMatch(/opacity/);
	});

	it('says nothing about access with one account (S4-D1)', async () => {
		renderRow({ singleUser: true });
		expect(screen.queryByText('Private')).toBeNull();
		const menu = await openMenu();
		expect(within(menu).queryByText('Make public')).toBeNull();
	});

	it('leaves out Pin by default and its badge under the one-account rule (S5-D12)', async () => {
		renderRow({ singleUser: true, pinsByDefault: false, isDefaultPinned: true, isSelected: true });
		expect(screen.queryByText('Pinned')).toBeNull();
		const menu = await openMenu();
		expect(within(menu).queryByText('Pin by default')).toBeNull();
		expect(within(menu).getAllByRole('menuitemcheckbox')).toHaveLength(2);
	});

	it('opens the editor from the pencil button and from the row', () => {
		const h = renderRow();
		fireEvent.click(screen.getByRole('button', { name: 'Edit Model One' }));
		fireEvent.click(screen.getByText('Model One'));
		expect(h.open).toHaveBeenCalledTimes(2);
	});

	it('toggles enabled from the switch, named as on the other lists', () => {
		const h = renderRow();
		fireEvent.click(screen.getByRole('switch', { name: 'Enable Model One' }));
		expect(h.toggleActive).toHaveBeenCalledTimes(1);
	});

	it('draws the switch from its own state, outside any tooltip trigger (#912)', () => {
		renderRow();
		const on = screen.getByRole('switch', { name: 'Enable Model One' });
		expect(on.getAttribute('data-slot')).toBe('switch');
		expect(on.getAttribute('data-state')).toBe('checked');
	});

	it('draws an off switch as unchecked (#912)', () => {
		renderRow({ model: { ...MODEL, is_active: false } });
		const off = screen.getByRole('switch', { name: 'Enable Model One' });
		expect(off.getAttribute('data-slot')).toBe('switch');
		expect(off.getAttribute('data-state')).toBe('unchecked');
	});

	it('has no Shift-held quick buttons (S5-D11)', () => {
		renderRow();
		fireEvent.keyDown(window, { key: 'Shift', shiftKey: true });
		expect(screen.queryByRole('button', { name: /Selected Model|Pinned Model|^Hide$|Make Public/ })).toBeNull();
	});

	it('groups the menu: settings, copies, order, then Hide last (OVL-3)', async () => {
		renderRow();
		const menu = await openMenu();
		const items = Array.from(menu.querySelectorAll('[role=menuitem], [role=menuitemcheckbox]')).map(
			(i) => i.textContent
		);
		expect(items[0]).toContain('Default for new chats');
		expect(items[1]).toContain('Pin to sidebar');
		expect(items[2]).toContain('Pin by default');
		expect(items.at(-1)).toBe('Hide model');
		expect(within(menu).getAllByRole('separator')).toHaveLength(3);
	});

	it('marks each menu setting checked while it is on and runs its handler', async () => {
		const h = renderRow({ isSelected: true, isSidebarPinned: true });
		const menu = await openMenu();
		const settings = within(menu).getAllByRole('menuitemcheckbox');
		expect(settings.map((s) => s.getAttribute('aria-checked'))).toEqual(['true', 'true', 'false']);
		fireEvent.click(settings[2]);
		expect(h.toggleDefaultPinned).toHaveBeenCalledTimes(1);
	});

	it('runs the copies, the order and Hide from the menu', async () => {
		const h = renderRow();
		fireEvent.click(within(await openMenu()).getByText('Copy link'));
		fireEvent.click(within(await openMenu()).getByText('Clone'));
		fireEvent.click(within(await openMenu()).getByText('Export'));
		fireEvent.click(within(await openMenu()).getByText('Move up'));
		fireEvent.click(within(await openMenu()).getByText('Move down'));
		fireEvent.click(within(await openMenu()).getByText('Hide model'));
		fireEvent.click(within(await openMenu()).getByText('Make public'));
		expect(h.copyLink).toHaveBeenCalledTimes(1);
		expect(h.clone).toHaveBeenCalledTimes(1);
		expect(h.exportModel).toHaveBeenCalledTimes(1);
		expect(h.moveUp).toHaveBeenCalledTimes(1);
		expect(h.moveDown).toHaveBeenCalledTimes(1);
		expect(h.toggleHidden).toHaveBeenCalledTimes(1);
		expect(h.togglePrivacy).toHaveBeenCalledTimes(1);
	});

	it('offers Show model and Make private for the state they would undo', async () => {
		renderRow({
			model: {
				...MODEL,
				meta: { hidden: true },
				access_grants: [{ principal_type: 'user', principal_id: '*', permission: 'read' }]
			}
		});
		const menu = await openMenu();
		expect(within(menu).getByText('Show model')).toBeTruthy();
		expect(within(menu).getByText('Make private')).toBeTruthy();
	});

	it('turns off Move up on the first row of its group and Move down on the last', async () => {
		renderRow({ index: 0, count: 1 });
		const menu = await openMenu();
		expect(within(menu).getByText('Move up').closest('[role=menuitem]')?.hasAttribute('data-disabled')).toBe(true);
		expect(within(menu).getByText('Move down').closest('[role=menuitem]')?.hasAttribute('data-disabled')).toBe(true);
	});

	it('says reordering is off while a search or filter is set', () => {
		renderRow({ canReorder: false });
		expect(screen.getByRole('img', { name: 'Reordering is off while a search or filter is set' })).toBeTruthy();
	});

	it('shows the description on line 2, else the id', () => {
		renderRow({ model: { ...MODEL, meta: { description: 'Fast coder' } } });
		expect(screen.getByText('Fast coder')).toBeTruthy();
	});

	it('falls back to the id for the button names of a model with no name', () => {
		renderRow({ model: { id: 'raw/id', is_active: true } });
		expect(screen.getByRole('button', { name: 'Edit raw/id' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'More actions for raw/id' })).toBeTruthy();
		expect(screen.getByRole('switch', { name: 'Enable raw/id' })).toBeTruthy();
	});

	it('outlines the row being dragged instead of fading it', () => {
		renderRow({ dragging: true });
		expect(document.querySelector('[data-model-row="m1"]')?.getAttribute('data-dragging')).toBe('true');
	});
});
