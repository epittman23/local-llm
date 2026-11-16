import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Input } from '@/components/ui/input';
import { ConnectionUrlField, Disclosure, FormField, modelListResult, type TestResult, urlProblem } from './formFields';

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
});

describe('modelListResult', () => {
	it('counts the models in an OpenAI-style answer or a bare list', () => {
		expect(modelListResult({ data: [{ id: 'a' }, { id: 'b' }] })).toEqual({ ok: true, text: 'Reachable: 2 models' });
		expect(modelListResult([{ id: 'a' }])).toEqual({ ok: true, text: 'Reachable: 1 model' });
	});

	it('says when the server answered with something that is not a model list', () => {
		expect(modelListResult('<html>')).toEqual({
			ok: false,
			text: "Reached the server, but it didn't return a model list."
		});
		expect(modelListResult(null).ok).toBe(false);
	});
});

describe('urlProblem', () => {
	it('accepts http and https URLs', () => {
		expect(urlProblem('http://127.0.0.1:8090/v1')).toBeNull();
		expect(urlProblem(' https://openrouter.ai/api/v1 ')).toBeNull();
	});

	it('asks for a URL, and for http or https', () => {
		expect(urlProblem('  ')).toBe('Enter the server’s URL.');
		expect(urlProblem('not a url')).toBe('Enter a URL that starts with http:// or https://.');
		expect(urlProblem('ftp://host')).toBe('Enter a URL that starts with http:// or https://.');
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
