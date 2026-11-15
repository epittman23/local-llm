import { fireEvent, render, screen } from '@testing-library/react';
import { toast } from 'sonner';
import { describe, expect, it, vi } from 'vitest';
import { AttachWebpageDialog } from './AttachWebpageDialog';

const renderDialog = (props: Partial<Parameters<typeof AttachWebpageDialog>[0]> = {}) => {
	const onSubmit = vi.fn();
	const onOpenChange = vi.fn();
	render(<AttachWebpageDialog open onOpenChange={onOpenChange} onSubmit={onSubmit} {...props} />);
	return { onSubmit, onOpenChange };
};

describe('AttachWebpageDialog', () => {
	it("keeps chat's title and button when the caller names neither", () => {
		renderDialog();
		expect(screen.getByRole('dialog', { name: 'Attach a web page' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument();
	});

	it("takes the caller's title and button words (ACT-2)", () => {
		renderDialog({ title: 'Add a web page', submitLabel: 'Add web page' });
		expect(screen.getByRole('dialog', { name: 'Add a web page' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Add web page' })).toBeInTheDocument();
	});

	it('sends each valid address once and closes', () => {
		const { onSubmit, onOpenChange } = renderDialog();
		fireEvent.change(screen.getByLabelText('Webpage URLs'), {
			target: { value: 'https://a.example\nnot a url\nhttps://a.example\nhttp://b.example' }
		});
		fireEvent.click(screen.getByRole('button', { name: 'Add' }));
		expect(onSubmit).toHaveBeenCalledWith(['https://a.example', 'http://b.example']);
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it('says what a valid address looks like when there is none', () => {
		const error = vi.spyOn(toast, 'error');
		const { onSubmit } = renderDialog();
		fireEvent.change(screen.getByLabelText('Webpage URLs'), { target: { value: 'nope' } });
		fireEvent.click(screen.getByRole('button', { name: 'Add' }));
		expect(onSubmit).not.toHaveBeenCalled();
		expect(error).toHaveBeenCalledWith('Enter at least one web address that starts with http:// or https://.');
	});

	it('closes on Cancel without sending', () => {
		const { onSubmit, onOpenChange } = renderDialog();
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(onSubmit).not.toHaveBeenCalled();
	});
});
