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
	it('starts collapsed and opens from the Model Defaults button', () => {
		renderPanel();
		expect(screen.queryByRole('button', { name: /Model Capabilities/ })).toBeNull();
		fireEvent.click(screen.getByRole('button', { name: 'Model Defaults' }));
		expect(screen.getByRole('button', { name: /Model Capabilities/ })).toBeTruthy();
	});

	it('toggles from the configure button and reports its expanded state', () => {
		renderPanel();
		const toggle = screen.getByRole('button', { name: 'Configure model defaults' });
		expect(toggle.getAttribute('aria-expanded')).toBe('false');
		fireEvent.click(toggle);
		expect(toggle.getAttribute('aria-expanded')).toBe('true');
		expect(toggle.textContent).toBe('Close');
	});

	it('opens and closes a section from its heading', () => {
		renderPanel();
		fireEvent.click(screen.getByRole('button', { name: 'Model Defaults' }));
		const section = screen.getByRole('button', { name: /Prompt Suggestions/ });
		expect(section.getAttribute('aria-expanded')).toBe('false');
		expect(section.textContent).toContain('Configure');
		fireEvent.click(section);
		expect(section.getAttribute('aria-expanded')).toBe('true');
		expect(section.textContent).toContain('Close');
		fireEvent.click(section);
		expect(section.getAttribute('aria-expanded')).toBe('false');
	});

	it('reports a changed capability to the parent', () => {
		const onChange = renderPanel();
		fireEvent.click(screen.getByRole('button', { name: 'Model Defaults' }));
		fireEvent.click(screen.getByRole('button', { name: /Model Capabilities/ }));
		const boxes = screen.getAllByRole('checkbox');
		fireEvent.click(boxes[0]);
		expect(onChange).toHaveBeenCalledTimes(1);
	});
});
