import { fireEvent, render, screen } from '@testing-library/react';
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
				shiftKey={false}
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

describe('ModelRow', () => {
	it('shows the name with its access label and the selected and pinned flags', () => {
		renderRow({ isSelected: true, isDefaultPinned: true });
		expect(screen.getByText('Model One')).toBeTruthy();
		expect(screen.getByText('Private')).toBeTruthy();
		expect(screen.getByText('Selected')).toBeTruthy();
		expect(screen.getByText('Pinned')).toBeTruthy();
	});

	it('labels a model with a public read grant as Public', () => {
		renderRow({
			model: { ...MODEL, access_grants: [{ principal_type: 'user', principal_id: '*', permission: 'read' }] }
		});
		expect(screen.getByText('Public')).toBeTruthy();
	});

	it('opens the editor from the pencil button', () => {
		const h = renderRow();
		fireEvent.click(screen.getByRole('button', { name: 'Edit Model One' }));
		expect(h.open).toHaveBeenCalledTimes(1);
	});

	it('toggles enabled from the switch', () => {
		const h = renderRow();
		fireEvent.click(screen.getByRole('switch', { name: 'Model One enabled' }));
		expect(h.toggleActive).toHaveBeenCalledTimes(1);
	});

	it('shows the quick-action buttons only while shift is held', () => {
		renderRow();
		expect(screen.queryByRole('button', { name: 'Set as Selected Model' })).toBeNull();
	});

	it('runs each quick action while shift is held', () => {
		const h = renderRow({ shiftKey: true });
		fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
		fireEvent.click(screen.getByRole('button', { name: 'Set as Selected Model' }));
		fireEvent.click(screen.getByRole('button', { name: 'Set as Pinned Model' }));
		fireEvent.click(screen.getByRole('button', { name: 'Make Public' }));
		expect(h.toggleHidden).toHaveBeenCalledTimes(1);
		expect(h.toggleSelected).toHaveBeenCalledTimes(1);
		expect(h.toggleDefaultPinned).toHaveBeenCalledTimes(1);
		expect(h.togglePrivacy).toHaveBeenCalledTimes(1);
	});

	it('names the quick actions for the state they would undo', () => {
		renderRow({
			shiftKey: true,
			isSelected: true,
			isDefaultPinned: true,
			model: { ...MODEL, meta: { hidden: true } }
		});
		expect(screen.getByRole('button', { name: 'Show' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Remove Selected Model' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Remove Pinned Model' })).toBeTruthy();
	});

	it('has a More actions menu button named for the model', () => {
		renderRow();
		expect(screen.getByRole('button', { name: 'More actions for Model One' })).toBeTruthy();
	});

	it('says reordering is off while filters are set', () => {
		renderRow({ canReorder: false });
		expect(screen.getByRole('img', { name: 'Reordering is off while filters are set' })).toBeTruthy();
	});

	it('offers Make Private on a public model', () => {
		const h = renderRow({
			shiftKey: true,
			model: { ...MODEL, access_grants: [{ principal_type: 'user', principal_id: '*', permission: 'read' }] }
		});
		fireEvent.click(screen.getByRole('button', { name: 'Make Private' }));
		expect(h.togglePrivacy).toHaveBeenCalledTimes(1);
	});

	it('falls back to the id for the button names of a model with no name', () => {
		renderRow({ model: { id: 'raw/id', is_active: true } });
		expect(screen.getByRole('button', { name: 'Edit raw/id' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'More actions for raw/id' })).toBeTruthy();
		expect(screen.getByRole('switch', { name: 'raw/id enabled' })).toBeTruthy();
	});
});
