import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { useAttachments } from './useAttachments';

// An upload that never answers, so the test sees the state while it is in flight.
vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn() } }));
vi.mock('@/lib/apis/files', () => ({ uploadFile: vi.fn(() => new Promise(() => {})) }));
vi.mock('@/lib/apis/users', () => ({ getUserSettings: vi.fn(async () => ({ ui: {} })), updateUserSettings: vi.fn() }));
// Each page is processed when the test answers it.
const pages: ((v: unknown) => void)[] = [];
vi.mock('@/lib/apis/retrieval', () => ({
	processUrl: vi.fn(() => new Promise((resolve) => pages.push(resolve)))
}));

const wrapper = ({ children }: { children: ReactNode }) => (
	<QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
);
const models = [{ id: 'm', name: 'M' }];
const blind = { id: 'text-only', name: 'Text only', info: { meta: { capabilities: { vision: false } } } };
const image = () => new File([new Uint8Array([137, 80, 78, 71])], 'photo.png', { type: 'image/png' });

describe('useAttachments', () => {
	beforeEach(() => {
		vi.mocked(toast.error).mockClear();
		vi.mocked(toast.warning).mockClear();
		useAuthStore.setState({
			status: 'authenticated',
			token: 't',
			user: { id: 'u1', email: '', name: 'U', role: 'admin', profile_image_url: '' }
		});
		useConfigStore.setState({ config: null });
	});

	it('lists an image as uploading at once, before it is read, so Send waits for it (docs/history/code-review.md L10)', () => {
		const { result } = renderHook(
			() => useAttachments({ temporary: false, selectedModels: ['m'], models, chatId: null }),
			{ wrapper }
		);
		act(() => result.current.addFiles([image()]));
		expect(result.current.files).toEqual([expect.objectContaining({ name: 'photo.png', status: 'uploading' })]);
	});

	it("a temporary chat's image becomes a data URL", async () => {
		const { result } = renderHook(
			() => useAttachments({ temporary: true, selectedModels: ['m'], models, chatId: null }),
			{ wrapper }
		);
		act(() => result.current.addFiles([image()]));
		expect(result.current.files).toEqual([expect.objectContaining({ type: 'image', status: 'uploading' })]);
		await waitFor(() =>
			expect(result.current.files[0]).toMatchObject({
				type: 'image',
				status: 'uploaded',
				url: expect.stringMatching(/^data:image\/png;base64,/)
			})
		);
	});

	it('pasted text asked for in full is attached with its whole content', () => {
		const { result } = renderHook(
			() => useAttachments({ temporary: false, selectedModels: ['m'], models, chatId: null }),
			{ wrapper }
		);
		act(() =>
			result.current.addFiles([new File(['long text'], 'Pasted_Text_1.txt', { type: 'text/plain' })], {
				context: 'full'
			})
		);
		expect(result.current.files).toEqual([
			expect.objectContaining({ name: 'Pasted_Text_1.txt', status: 'uploading', context: 'full' })
		]);
	});

	it('pages still waiting when the list is cleared do not come back into it (#217)', async () => {
		const { result } = renderHook(
			() => useAttachments({ temporary: false, selectedModels: ['m'], models, chatId: null }),
			{ wrapper }
		);
		let adding: Promise<void> | undefined;
		act(() => {
			adding = result.current.addWeb(['https://a.example/1', 'https://a.example/2']);
		});
		// Both are listed at once, so Send waits for both.
		expect(result.current.files.map((f) => f.name)).toEqual(['https://a.example/1', 'https://a.example/2']);

		act(() => result.current.clear());
		await act(async () => {
			pages[0]({ name: 'one', content: 'page one' });
			await waitFor(() => expect(pages).toHaveLength(2));
			pages[1]({ name: 'two', content: 'page two' });
			await adding;
		});
		expect(result.current.files).toEqual([]);
	});

	it('an image is refused when no selected model can see images, and the other files still go (#219)', () => {
		const { result } = renderHook(
			() => useAttachments({ temporary: false, selectedModels: ['text-only'], models: [blind] as never, chatId: null }),
			{ wrapper }
		);
		act(() => result.current.addFiles([image(), new File(['notes'], 'notes.txt', { type: 'text/plain' })]));
		expect(result.current.files).toEqual([expect.objectContaining({ name: 'notes.txt', status: 'uploading' })]);
		expect(toast.error).toHaveBeenCalledWith('Selected model(s) do not support image inputs');
	});

	it('an image is kept when at least one selected model can see images (#219)', () => {
		const { result } = renderHook(
			() =>
				useAttachments({
					temporary: false,
					selectedModels: ['text-only', 'm'],
					models: [blind, ...models] as never,
					chatId: null
				}),
			{ wrapper }
		);
		act(() => result.current.addFiles([image()]));
		expect(result.current.files).toEqual([expect.objectContaining({ name: 'photo.png', status: 'uploading' })]);
		expect(toast.warning).toHaveBeenCalledWith('Model(s) are not vision capable');
		expect(toast.error).not.toHaveBeenCalledWith('Selected model(s) do not support image inputs');
	});

	it.each([
		['image/heic', 'photo.heic'],
		['image/heif', 'photo.heif'],
		['', 'IMG_0001.HEIC']
	])('a HEIC image (%s %s) is refused, not uploaded raw, and the other files still go (#220)', (type, name) => {
		const { result } = renderHook(
			() => useAttachments({ temporary: false, selectedModels: ['m'], models, chatId: null }),
			{ wrapper }
		);
		act(() =>
			result.current.addFiles([
				new File([new Uint8Array([0, 0, 0, 24])], name, { type }),
				new File(['notes'], 'notes.txt', { type: 'text/plain' })
			])
		);
		expect(result.current.files).toEqual([expect.objectContaining({ name: 'notes.txt', status: 'uploading' })]);
		expect(toast.error).toHaveBeenCalledWith('HEIC images are not supported. Convert the image to JPEG or PNG first.');
		expect(toast.error).toHaveBeenCalledTimes(1);
	});

	it('a JPEG whose name ends in .heic is still attached (#220)', () => {
		const { result } = renderHook(
			() => useAttachments({ temporary: false, selectedModels: ['m'], models, chatId: null }),
			{ wrapper }
		);
		act(() => result.current.addFiles([new File([new Uint8Array([255, 216])], 'photo.heic', { type: 'image/jpeg' })]));
		expect(result.current.files).toEqual([expect.objectContaining({ name: 'photo.heic', status: 'uploading' })]);
	});
});
