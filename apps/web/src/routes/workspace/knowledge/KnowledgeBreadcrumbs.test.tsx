import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { KnowledgeBreadcrumbs } from './KnowledgeFileList';

describe('KnowledgeBreadcrumbs', () => {
	const crumbs = [
		{ id: 'd1', name: 'Docs' },
		{ id: 'd2', name: 'Specs' }
	];

	it('navigates to the root from the root button', () => {
		const onNavigate = vi.fn();
		render(<KnowledgeBreadcrumbs rootLabel="Library" breadcrumbs={crumbs} onNavigate={onNavigate} onMove={vi.fn()} />);
		fireEvent.click(screen.getByRole('button', { name: 'Library' }));
		expect(onNavigate).toHaveBeenCalledWith(null);
	});

	it('navigates to a folder from its crumb', () => {
		const onNavigate = vi.fn();
		render(<KnowledgeBreadcrumbs rootLabel="Library" breadcrumbs={crumbs} onNavigate={onNavigate} onMove={vi.fn()} />);
		fireEvent.click(screen.getByRole('button', { name: 'Docs' }));
		expect(onNavigate).toHaveBeenCalledWith('d1');
	});

	it('moves a dropped item into the crumb it is dropped on', () => {
		const onMove = vi.fn();
		render(<KnowledgeBreadcrumbs rootLabel="Library" breadcrumbs={crumbs} onNavigate={vi.fn()} onMove={onMove} />);
		const payload = JSON.stringify({ fileId: 'f1' });
		const dataTransfer = {
			types: ['application/x-kb-file-move'],
			getData: () => payload
		};
		fireEvent.drop(screen.getByRole('button', { name: 'Docs' }), { dataTransfer });
		expect(onMove).toHaveBeenCalledWith({ kind: 'file', id: 'f1' }, 'd1');
	});

	it('highlights the crumb a move is dragged over and clears it on leaving', () => {
		render(<KnowledgeBreadcrumbs rootLabel="Library" breadcrumbs={crumbs} onNavigate={vi.fn()} onMove={vi.fn()} />);
		const dataTransfer = { types: ['application/x-kb-file-move'], getData: () => '' };
		const root = screen.getByRole('button', { name: 'Library' });
		const docs = screen.getByRole('button', { name: 'Docs' });
		fireEvent.dragOver(root, { dataTransfer });
		expect(root.className).toContain('bg-surface-3');
		fireEvent.dragLeave(root);
		expect(root.className).not.toContain('bg-surface-3');
		fireEvent.dragOver(docs, { dataTransfer });
		expect(docs.className).toContain('bg-surface-3');
	});
});
