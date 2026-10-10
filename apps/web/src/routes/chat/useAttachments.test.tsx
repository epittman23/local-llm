import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { useAttachments } from './useAttachments';

// An upload that never answers, so the test sees the state while it is in flight.
vi.mock('@/lib/apis/files', () => ({ uploadFile: vi.fn(() => new Promise(() => {})) }));
vi.mock('@/lib/apis/users', () => ({ getUserSettings: vi.fn(async () => ({ ui: {} })), updateUserSettings: vi.fn() }));

const wrapper = ({ children }: { children: ReactNode }) => (
	<QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
);
const models = [{ id: 'm', name: 'M' }];
const image = () => new File([new Uint8Array([137, 80, 78, 71])], 'photo.png', { type: 'image/png' });

describe('useAttachments', () => {
	beforeEach(() => {
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
});
