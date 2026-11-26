import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Message } from '@/lib/chat/history';
import { id, output } from './testing';
import { useCanvasAutoOpen } from './useCanvasAutoOpen';

const reply = (id: string, files: Message['files'], content = 'Done.'): Message => ({
	id,
	parentId: null,
	childrenIds: [],
	role: 'assistant',
	content,
	done: true,
	files
});

function setup(history: Message[], over: Partial<Parameters<typeof useCanvasAutoOpen>[0]> = {}) {
	const open = vi.fn();
	const props = { history, generating: true, enabled: true, isLg: true, canvas: { openId: null, open }, ...over };
	const hook = renderHook((p) => useCanvasAutoOpen(p), { initialProps: props });
	return {
		open,
		hook,
		finish: (history2 = history) => hook.rerender({ ...props, history: history2, generating: false })
	};
}

describe('useCanvasAutoOpen', () => {
	it('opens the one new document when a reply finishes, replacing the entry, and says which it opened', () => {
		const message = reply('a1', [output('e', 'report.html')]);
		const { open, hook, finish } = setup([message]);
		expect(open).not.toHaveBeenCalled();
		finish();
		expect(open).toHaveBeenCalledWith(message.files?.[0].id, { replace: true });
		expect(hook.result.current).toBe(message.files?.[0].id);
	});

	it('never opens on load: only a true to false change of generating counts', () => {
		const { open } = setup([reply('a1', [output('e', 'report.html')])], { generating: false });
		expect(open).not.toHaveBeenCalled();
	});

	it('does nothing with two documents, none, or a file the sandbox did not write', () => {
		for (const files of [
			[output('e', 'a.html'), output('f', 'b.html')],
			[],
			[{ ...output('e', 'mine.html'), meta: undefined }]
		] as Message['files'][]) {
			const { open, finish } = setup([reply('a1', files)]);
			finish();
			expect(open).not.toHaveBeenCalled();
		}
	});

	it('does not count a PDF’s page previews as documents', () => {
		const files = [output('e', 'paper.pdf'), output('f', 'page-1.png', { preview_of: id('e'), preview_page: 1 })];
		const { open, finish } = setup([reply('a1', files)]);
		finish();
		expect(open).toHaveBeenCalledWith(id('e'), { replace: true });
	});

	it('counts a qualifying html block, not a long code block', () => {
		const html = reply('a2', [], `Here:\n\`\`\`html\n<!doctype html><p>x</p>\n\`\`\``);
		const first = setup([html]);
		first.finish();
		expect(first.open).toHaveBeenCalledWith('block:a2:0', { replace: true });
		const python = reply('a3', [], `\`\`\`python\n${'x = 1\n'.repeat(20)}\`\`\``);
		const second = setup([python]);
		second.finish();
		expect(second.open).not.toHaveBeenCalled();
	});

	it('respects the setting, the window width and an open canvas', () => {
		const history = [reply('a1', [output('e', 'report.html')])];
		for (const over of [{ enabled: false }, { isLg: false }, { canvas: { openId: 'x', open: vi.fn() } }]) {
			const { open, finish } = setup(history, over);
			finish();
			expect(open).not.toHaveBeenCalled();
			expect(over.canvas?.open ?? open).not.toHaveBeenCalled();
		}
	});

	it('opens once per message', () => {
		const message = reply('a1', [output('e', 'report.html')]);
		const open = vi.fn();
		const canvas = { openId: null, open };
		const { rerender } = renderHook((p) => useCanvasAutoOpen(p), {
			initialProps: { history: [message], generating: true, enabled: true, isLg: true, canvas }
		});
		for (const generating of [false, true, false])
			rerender({ history: [message], generating, enabled: true, isLg: true, canvas });
		expect(open).toHaveBeenCalledTimes(1);
	});

	it('forgets the auto-open when the canvas closes', () => {
		const message = reply('a1', [output('e', 'report.html')]);
		const open = vi.fn();
		const { result, rerender } = renderHook((p) => useCanvasAutoOpen(p), {
			initialProps: {
				history: [message],
				generating: true,
				enabled: true,
				isLg: true,
				canvas: { openId: null as string | null, open }
			}
		});
		rerender({ history: [message], generating: false, enabled: true, isLg: true, canvas: { openId: null, open } });
		const opened = result.current;
		expect(opened).not.toBeNull();
		rerender({ history: [message], generating: false, enabled: true, isLg: true, canvas: { openId: opened, open } });
		rerender({ history: [message], generating: false, enabled: true, isLg: true, canvas: { openId: null, open } });
		expect(result.current).toBeNull();
	});
});
