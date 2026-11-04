import { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { initialModels } from '@/lib/chat/request';
import { useUserSettings } from '@/lib/settings/userSettings';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { useModels } from './useModels';

type SavedChat = { id?: string; chat?: { models?: unknown } } | null | undefined;
type FolderQuery = { isFetched: boolean; data?: { data?: { model_ids?: string[] } | null } | null };

/**
 * Picks the models for the chat on screen: a saved chat brings its own; a new
 * one takes them from the URL, its folder, the user's settings or the
 * defaults. Gives whether a pick has been made since the page loaded. Until
 * then the input stays disabled: a message sent the moment the box appeared
 * was refused with "Model not selected", as no model was chosen yet (#373).
 * It stays true after: a chat started here moves to its own route mid-reply,
 * and another chat's loading already holds the input while it loads.
 */
export function useModelPick(chat: SavedChat, folder: FolderQuery, setSelectedModels: (ids: string[]) => void) {
	const { id = null, folderId = null } = useParams();
	const [search] = useSearchParams();
	const user = useAuthStore((s) => s.user);
	const config = useConfigStore((s) => s.config);
	const { settings } = useUserSettings();
	const { models, loaded } = useModels();
	const chatPerms = (user?.permissions as { chat?: Record<string, boolean> } | undefined)?.chat ?? {};
	const multiple = user?.role === 'admin' || (chatPerms.multiple_models ?? true);

	// What the pick reads but should not re-run it: only the chat or the model list changing does.
	const inputs = useRef({ search, settings, config, models, multiple, setSelectedModels });
	inputs.current = { search, settings, config, models, multiple, setSelectedModels };
	const folderModels = useRef(folder.data?.data?.model_ids);
	folderModels.current = folder.data?.data?.model_ids;

	const pickedFor = useRef<string | null>(null);
	const [chosen, setChosen] = useState(false);
	useEffect(() => {
		if (!loaded) return;
		const { search, settings, config, models, multiple, setSelectedModels } = inputs.current;
		if (id) {
			// While switching chats `chat` is still the previous chat's record
			// for a render or two; only take models from this route's own.
			if (chat?.id !== id) return;
			const saved = chat?.chat?.models as string[] | undefined;
			if (saved && pickedFor.current !== id) {
				pickedFor.current = id;
				setSelectedModels(multiple ? saved : saved.slice(0, 1));
			}
			setChosen(true);
			return;
		}
		if (folderId && !folder.isFetched) return;
		const key = `new:${folderId ?? ''}`;
		if (pickedFor.current !== key) {
			pickedFor.current = key;
			setSelectedModels(
				initialModels({
					url: search.get('models') || search.get('model'),
					folderModels: folderModels.current,
					userModels: (settings as { models?: string[] } | null)?.models,
					defaults: (config as { default_models?: string } | null)?.default_models,
					models
				})
			);
		}
		setChosen(true);
	}, [loaded, id, folderId, folder.isFetched, chat]);
	return chosen;
}
