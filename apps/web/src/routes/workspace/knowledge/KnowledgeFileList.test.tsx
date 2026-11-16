import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { KnowledgeFileList } from './KnowledgeFileList';

const nothing = () => {};

describe('KnowledgeFileList folders', () => {
	it('shows no time for a folder that was never dated, rather than a bare 0', () => {
		render(
			<TooltipProvider>
				<KnowledgeFileList
					files={[]}
					directories={[{ id: 'd1', name: 'Lecture notes', created_at: 0, updated_at: 0 }]}
					uploading={[]}
					writeAccess
					selectedFileId={null}
					onSelect={nothing}
					onDeleteFile={nothing}
					onRenameFile={nothing}
					onOpenDirectory={nothing}
					onRenameDirectory={nothing}
					onDeleteDirectory={nothing}
					onMove={nothing}
					onRetryUpload={nothing}
					onDismissUpload={nothing}
					showOwner={false}
				/>
			</TooltipProvider>
		);
		const row = screen.getByText('Lecture notes').closest('button') as HTMLElement;
		expect(row.textContent).toBe('Lecture notes');
	});
});
