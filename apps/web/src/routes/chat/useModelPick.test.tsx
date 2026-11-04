// The chat page's model pick, and whether it has been made (#373): until it
// has, the input stays disabled, as a message sent then was refused with
// "Model not selected".
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { useModelPick } from './useModelPick';

const route = vi.hoisted(() => ({ params: {} as Record<string, string>, search: '' }));
const lists = vi.hoisted(() => ({
	models: [] as { id: string }[],
	loaded: false,
	failed: false,
	settings: null as unknown
}));

vi.mock('react-router', async (orig) => ({
	...(await orig<typeof import('react-router')>()),
	useParams: () => route.params,
	useSearchParams: () => [new URLSearchParams(route.search), () => {}]
}));
vi.mock('./useModels', () => ({
	useModels: () => ({ models: lists.models, loaded: lists.loaded, failed: lists.failed })
}));
vi.mock('@/lib/settings/userSettings', () => ({ useUserSettings: () => ({ settings: lists.settings }) }));

const fetched = { isFetched: true, data: null };

beforeEach(() => {
	route.params = {};
	route.search = '';
	lists.models = [{ id: 'llama' }, { id: 'qwen' }];
	lists.loaded = false;
	lists.failed = false;
	lists.settings = null;
	useAuthStore.setState({ user: { id: 'u', role: 'user', permissions: { chat: {} } } } as never);
	useConfigStore.setState({ config: { default_models: 'qwen' } } as never);
});
afterEach(() => vi.clearAllMocks());

describe('useModelPick (#373)', () => {
	it('is not ready until the model list has loaded, then picks the URL model', () => {
		route.search = 'models=llama';
		const set = vi.fn();
		const { result, rerender } = renderHook(() => useModelPick(null, fetched, set));
		expect(result.current).toBe(false);
		expect(set).not.toHaveBeenCalled();

		lists.loaded = true;
		rerender();
		expect(set).toHaveBeenCalledWith(['llama']);
		expect(result.current).toBe(true);
	});

	it('picks the defaults for a new chat without a URL model, once', () => {
		lists.loaded = true;
		const set = vi.fn();
		const { result, rerender } = renderHook(() => useModelPick(null, fetched, set));
		rerender();
		expect(set).toHaveBeenCalledTimes(1);
		expect(set).toHaveBeenCalledWith(['qwen']);
		expect(result.current).toBe(true);
	});

	it('waits for a folder before picking a new chat in it', () => {
		lists.loaded = true;
		route.params = { folderId: 'f1' };
		const set = vi.fn();
		let folder: { isFetched: boolean; data: { data: { model_ids: string[] } } | null } = {
			isFetched: false,
			data: null
		};
		const { result, rerender } = renderHook(() => useModelPick(null, folder, set));
		expect(result.current).toBe(false);

		folder = { isFetched: true, data: { data: { model_ids: ['llama'] } } };
		rerender();
		expect(set).toHaveBeenCalledWith(['llama']);
		expect(result.current).toBe(true);
	});

	it("takes a saved chat's own models only once its record is the route's", () => {
		lists.loaded = true;
		route.params = { id: 'c2' };
		const set = vi.fn();
		let chat = { id: 'c1', chat: { models: ['qwen'] } };
		const { result, rerender } = renderHook(() => useModelPick(chat, fetched, set));
		expect(result.current).toBe(false);
		expect(set).not.toHaveBeenCalled();

		chat = { id: 'c2', chat: { models: ['llama', 'qwen'] } };
		rerender();
		expect(set).toHaveBeenCalledWith(['llama', 'qwen']);
		expect(result.current).toBe(true);
	});

	it("keeps one of a saved chat's models for a user who may not pick several", () => {
		lists.loaded = true;
		route.params = { id: 'c1' };
		useAuthStore.setState({
			user: { id: 'u', role: 'user', permissions: { chat: { multiple_models: false } } }
		} as never);
		const set = vi.fn();
		renderHook(() => useModelPick({ id: 'c1', chat: { models: ['llama', 'qwen'] } }, fetched, set));
		expect(set).toHaveBeenCalledWith(['llama']);
	});

	it('is ready for a saved chat without models of its own, and stays ready when the route moves on', () => {
		lists.loaded = true;
		route.params = { id: 'c1' };
		const set = vi.fn();
		const chat: { id: string; chat: { models?: string[] } } = { id: 'c1', chat: {} };
		const { result, rerender } = renderHook(() => useModelPick(chat, fetched, set));
		expect(result.current).toBe(true);
		expect(set).not.toHaveBeenCalled();

		// A chat started here takes its own route mid-reply, before its record is loaded.
		route.params = { id: 'new1' };
		rerender();
		expect(result.current).toBe(true);
	});
	it('is ready, with nothing picked, when the model list failed to load', () => {
		lists.failed = true;
		const set = vi.fn();
		const { result } = renderHook(() => useModelPick(null, fetched, set));
		expect(result.current).toBe(true);
		expect(set).not.toHaveBeenCalled();
	});
});
