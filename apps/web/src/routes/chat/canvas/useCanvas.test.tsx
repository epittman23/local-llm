import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { Message } from '@/lib/chat/history';
import { id, output } from './testing';
import { useCanvas } from './useCanvas';

const reply: Message = {
	id: 'a1',
	parentId: null,
	childrenIds: [],
	role: 'assistant',
	content: 'Here.',
	done: true,
	files: [output('e', 'report.html')]
};
const docId = reply.files?.[0].id as string;

function setup(url: string, messages: Message[], loading = false) {
	return renderHook(
		() => {
			const canvas = useCanvas(messages, loading);
			const location = useLocation();
			return { canvas, location };
		},
		{ wrapper: ({ children }) => <MemoryRouter initialEntries={[url]}>{children}</MemoryRouter> }
	);
}

describe('useCanvas', () => {
	it('reads ?canvas= and finds the document', () => {
		const { result } = setup(`/c/x?canvas=${docId}`, [reply]);
		expect(result.current.canvas.openId).toBe(docId);
		expect(result.current.canvas.doc?.name).toBe('report.html');
		expect(result.current.canvas.gone).toBe(false);
		expect(result.current.canvas.documents.map((d) => d.id)).toEqual([docId]);
	});

	it('is closed without the parameter', () => {
		const { result } = setup('/c/x', [reply]);
		expect(result.current.canvas.openId).toBeNull();
		expect(result.current.canvas.doc).toBeNull();
		expect(result.current.canvas.gone).toBe(false);
	});

	it('writes ?canvas= on open and removes it on close, keeping the page’s other parameters', () => {
		const { result } = setup('/c/x?q=hello&temporary-chat=true', [reply]);
		act(() => result.current.canvas.open(docId));
		const params = new URLSearchParams(result.current.location.search);
		expect(params.get('canvas')).toBe(docId);
		expect(params.get('q')).toBe('hello');
		expect(params.get('temporary-chat')).toBe('true');
		expect(result.current.canvas.doc?.id).toBe(docId);
		act(() => result.current.canvas.close());
		const after = new URLSearchParams(result.current.location.search);
		expect(after.has('canvas')).toBe(false);
		expect(after.get('q')).toBe('hello');
		expect(result.current.canvas.openId).toBeNull();
	});

	it('is gone only once the chat has loaded and has no such document', () => {
		const url = '/c/x?canvas=block:zzz:0';
		expect(setup(url, [], true).result.current.canvas.gone).toBe(false);
		const loaded = setup(url, [reply]).result.current.canvas;
		expect(loaded.gone).toBe(true);
		expect(loaded.doc).toBeNull();
		expect(loaded.openId).toBe('block:zzz:0');
	});

	it('opens a knowledge file the branch cites by file:<uuid>, outside the document list, and is gone for one it does not', () => {
		const file = id('77');
		const cites = {
			...reply,
			id: 'a2',
			sources: [{ document: ['a passage'], metadata: [{ file_id: file, name: 'notes.md', source: 'notes.md' }] }]
		} as Message;
		const cited = setup(`/c/x?canvas=file:${file}`, [reply, cites]).result.current.canvas;
		expect(cited.doc?.source.type).toBe('knowledge');
		expect(cited.doc?.name).toBe('notes.md');
		expect(cited.gone).toBe(false);
		expect(cited.documents.map((d) => d.id)).toEqual([docId]);
		for (const forged of [`file:${id('78')}`, 'file:not-a-uuid', `file:${file}/x`]) {
			const gone = setup(`/c/x?canvas=${forged}`, [reply, cites]).result.current.canvas;
			expect(gone.doc).toBeNull();
			expect(gone.gone).toBe(true);
		}
		expect(setup(`/c/x?canvas=file:${file}`, [reply]).result.current.canvas.gone).toBe(true);
		expect(setup(`/c/x?canvas=file:${file}`, [], true).result.current.canvas.gone).toBe(false);
	});

	it('moves file:<uuid> to the document id when the cited file is one of the chat’s own documents', () => {
		const cites = {
			...reply,
			id: 'a3',
			sources: [{ document: ['a passage'], metadata: [{ file_id: docId, name: 'report.html', source: 'report.html' }] }]
		} as Message;
		const { result } = setup(`/c/x?canvas=file:${docId}`, [reply, cites]);
		expect(result.current.canvas.openId).toBe(docId);
		expect(result.current.canvas.doc?.id).toBe(docId);
		expect(result.current.location.search).toBe(`?canvas=${docId}`);
	});

	it('pushes a history entry on open, so Back closes it; an auto-open replaces, so Back leaves the chat', () => {
		const back = () => {
			const { result } = renderHook(
				() => ({ canvas: useCanvas([reply], false), location: useLocation(), navigate: useNavigate() }),
				{
					wrapper: ({ children }) => (
						<MemoryRouter initialEntries={['/c/prev', '/c/x']} initialIndex={1}>
							{children}
						</MemoryRouter>
					)
				}
			);
			return result;
		};
		const pushed = back();
		act(() => pushed.current.canvas.open(docId));
		act(() => void pushed.current.navigate(-1));
		expect(pushed.current.location.pathname).toBe('/c/x');
		expect(pushed.current.canvas.openId).toBeNull();

		const replaced = back();
		act(() => replaced.current.canvas.open(docId, { replace: true }));
		expect(replaced.current.canvas.openId).toBe(docId);
		act(() => void replaced.current.navigate(-1));
		expect(replaced.current.location.pathname).toBe('/c/prev');
	});
});
