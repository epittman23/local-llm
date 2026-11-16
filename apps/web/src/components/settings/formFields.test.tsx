import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Input } from '@/components/ui/input';
import type { TestResult } from './connectionModel';
import { ConnectionUrlField, Disclosure, FormField } from './formFields';

function Held({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
	const [open, setOpen] = useState(true);
	return (
		<Disclosure
			title="Orchestrator"
			open={open}
			onOpenChange={(next) => {
				onOpenChange(next);
				setOpen(next);
			}}
		>
			<p>Inside</p>
		</Disclosure>
	);
}

function Opener() {
	const [open, setOpen] = useState(false);
	return (
		<>
			<button type="button" onClick={() => setOpen(true)}>
				Open from outside
			</button>
			<Disclosure title="Advanced" open={open} onOpenChange={setOpen}>
				<p>Inside</p>
			</Disclosure>
		</>
	);
}

function Field({ onTest, error }: { onTest: () => Promise<TestResult | null>; error?: string | null }) {
	const [value, setValue] = useState('http://127.0.0.1:9');
	return <ConnectionUrlField id="url" value={value} onChange={setValue} onTest={onTest} error={error} />;
}

describe('FormField', () => {
	it('labels its control, marks it optional, and describes it by its help line', () => {
		render(
			<FormField id="key" label="API key" optional help="From your provider's dashboard.">
				{(props) => <Input {...props} />}
			</FormField>
		);
		const input = screen.getByLabelText(/API key/);
		expect(screen.getByText('(optional)')).toBeTruthy();
		expect(input).toHaveAccessibleDescription("From your provider's dashboard.");
		expect(input.getAttribute('aria-invalid')).toBeNull();
	});

	it('shows an error in place of the help and marks the control invalid (FRM-2)', () => {
		render(
			<FormField id="name" label="Name" help="Shown in the list." error="Enter a name.">
				{(props) => <Input {...props} />}
			</FormField>
		);
		const input = screen.getByLabelText('Name');
		expect(input.getAttribute('aria-invalid')).toBe('true');
		expect(input).toHaveAccessibleDescription('Enter a name.');
	});
});

describe('Disclosure', () => {
	it('opens and closes its body, saying so with aria-expanded', () => {
		render(
			<Disclosure title="Advanced">
				<p>Inside</p>
			</Disclosure>
		);
		const button = screen.getByRole('button', { name: 'Advanced' });
		expect(button.getAttribute('aria-expanded')).toBe('false');
		expect(screen.queryByText('Inside')).toBeNull();
		fireEvent.click(button);
		expect(button.getAttribute('aria-expanded')).toBe('true');
		expect(screen.getByText('Inside')).toBeTruthy();
		expect(document.getElementById(button.getAttribute('aria-controls') ?? '')?.textContent).toBe('Inside');
	});

	it('follows a parent that holds its state', () => {
		const onOpenChange = vi.fn();
		render(<Held onOpenChange={onOpenChange} />);
		expect(screen.getByText('Inside')).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Orchestrator' }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(screen.queryByText('Inside')).toBeNull();
	});

	it('is named by its title and described by its second line and meta, in a heading when asked', () => {
		render(
			<Disclosure title="Chat" description="What members can do in a chat." meta={<span>2 changed</span>} level={3}>
				<p>Inside</p>
			</Disclosure>
		);
		const button = screen.getByRole('button', { name: 'Chat' });
		expect(button).toHaveAccessibleDescription('What members can do in a chat. 2 changed');
		expect(screen.getByRole('heading', { level: 3, name: 'Chat' })).toContainElement(button);
		const panel = document.getElementById(button.getAttribute('aria-controls') ?? '') as HTMLElement;
		expect(panel.hidden).toBe(true);
		expect(panel.className).toContain('rounded-lg border p-3');
	});

	it('brings itself into view when clicked open, but not when its holder opens it or on mount', () => {
		const scrolled = vi.fn();
		Element.prototype.scrollIntoView = scrolled;
		render(<Opener />);
		fireEvent.click(screen.getByRole('button', { name: 'Open from outside' }));
		expect(screen.getByText('Inside')).toBeTruthy();
		expect(scrolled).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
		expect(scrolled).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
		expect(scrolled).toHaveBeenCalledWith({ block: 'nearest' });
	});
});

describe('ConnectionUrlField', () => {
	it('shows a reachable result under the URL in the success colour', async () => {
		render(<Field onTest={async () => ({ ok: true, text: 'Reachable: 3 models' })} />);
		fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
		const status = (await screen.findByText('Reachable: 3 models')).closest('[role=status]') as HTMLElement;
		expect(status.textContent).toBe('Reachable: 3 models');
		expect(status.className).toContain('text-success');
		expect(screen.getByLabelText('URL').getAttribute('aria-invalid')).toBeNull();
	});

	it('shows the reason a test failed, marks the URL invalid, and clears it on an edit', async () => {
		render(<Field onTest={async () => ({ ok: false, text: 'Connection refused at 127.0.0.1:9.' })} />);
		fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
		const input = screen.getByLabelText('URL');
		await waitFor(() => expect(input.getAttribute('aria-invalid')).toBe('true'));
		expect(input).toHaveAccessibleDescription('Connection refused at 127.0.0.1:9.');
		fireEvent.change(input, { target: { value: 'http://127.0.0.1:4190' } });
		expect(input.getAttribute('aria-invalid')).toBeNull();
	});

	it('is busy while testing, so it cannot be pressed twice (ACT-5)', async () => {
		let finish: (r: TestResult | null) => void = () => {};
		const onTest = vi.fn(() => new Promise<TestResult | null>((resolve) => (finish = resolve)));
		render(<Field onTest={onTest} />);
		fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
		const busy = await screen.findByRole('button', { name: /Testing…/ });
		expect(busy).toBeDisabled();
		finish(null);
		await screen.findByRole('button', { name: 'Test connection' });
		expect(onTest).toHaveBeenCalledTimes(1);
	});

	it("shows the form's own check of the URL in the same place", () => {
		render(<Field onTest={async () => null} error="Enter a URL that starts with http:// or https://." />);
		expect(screen.getByLabelText('URL')).toHaveAccessibleDescription(
			'Enter a URL that starts with http:// or https://.'
		);
	});
});
