import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { defaultsFromConfig } from './adminModels';
import { ModelDefaultsPanel } from './ModelDefaultsPanel';

const renderPanel = () => {
	const onChange = vi.fn();
	render(
		<TooltipProvider>
			<ModelDefaultsPanel value={defaultsFromConfig({}, [])} onChange={onChange} />
		</TooltipProvider>
	);
	return onChange;
};

describe('ModelDefaultsPanel', () => {
	it('starts closed and opens from its one Model defaults disclosure (#960)', () => {
		renderPanel();
		expect(screen.queryByRole('button', { name: 'Capabilities' })).toBeNull();
		fireEvent.click(screen.getByRole('button', { name: 'Model defaults' }));
		expect(screen.getByRole('button', { name: 'Capabilities' })).toBeTruthy();
	});

	it('is a chevron disclosure that says whether it is open, with no Configure buttons (FRM-6)', () => {
		renderPanel();
		const toggle = screen.getByRole('button', { name: 'Model defaults' });
		expect(toggle.getAttribute('aria-expanded')).toBe('false');
		expect(toggle.querySelector('svg')).toBeTruthy();
		fireEvent.click(toggle);
		expect(toggle.getAttribute('aria-expanded')).toBe('true');
		expect(screen.queryByText('Configure')).toBeNull();
		expect(screen.queryByRole('button', { name: 'Configure model defaults' })).toBeNull();
	});

	it('opens and closes each inner section in place, with no inner scroll box, and brings it into view', () => {
		const scrolled = vi.fn();
		Element.prototype.scrollIntoView = scrolled;
		renderPanel();
		fireEvent.click(screen.getByRole('button', { name: 'Model defaults' }));
		const sections = ['Capabilities', 'Parameters', 'Prompt suggestions'].map((name) =>
			screen.getByRole('button', { name })
		);
		const section = sections[2];
		expect(section.getAttribute('aria-expanded')).toBe('false');
		scrolled.mockClear();
		fireEvent.click(section);
		expect(section.getAttribute('aria-expanded')).toBe('true');
		expect(scrolled).toHaveBeenCalledWith({ block: 'nearest', behavior: 'smooth' });
		const body = document.getElementById(section.getAttribute('aria-controls') ?? '') as HTMLElement;
		expect(body.hidden).toBe(false);
		expect(body.outerHTML).not.toMatch(/max-h-|overflow-y-auto/);
		fireEvent.click(section);
		expect(section.getAttribute('aria-expanded')).toBe('false');
	});

	it('reports a changed capability to the parent', () => {
		const onChange = renderPanel();
		fireEvent.click(screen.getByRole('button', { name: 'Model defaults' }));
		fireEvent.click(screen.getByRole('button', { name: 'Capabilities' }));
		expect(screen.getByRole('group', { name: 'What a new model can do' })).toBeTruthy();
		const boxes = screen.getAllByRole('checkbox');
		fireEvent.click(boxes[0]);
		expect(onChange).toHaveBeenCalledTimes(1);
	});
});
