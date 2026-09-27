import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import { uploadFile } from '@/lib/apis/files';
import { processUrl } from '@/lib/apis/retrieval';
import { allCapable, canUploadFiles, canUploadWeb, imageTargetSize } from '@/lib/chat/attachments';
import type { ChatFile } from '@/lib/chat/history';
import { useUserSettings } from '@/lib/settings/userSettings';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import type { ChatModel } from './useModels';

const readAsDataUrl = (file: Blob) =>
	new Promise<string>((resolve, reject) => {
		const r = new FileReader();
		r.onload = () => resolve(String(r.result));
		r.onerror = () => reject(r.error);
		r.readAsDataURL(file);
	});

/** Scales an image (a data URL) to fit within width x height, keeping its shape. */
async function scaleImage(dataUrl: string, width: number | null, height: number | null): Promise<string> {
	const img = new Image();
	await new Promise((resolve, reject) => {
		img.onload = resolve;
		img.onerror = reject;
		img.src = dataUrl;
	});
	const ratio = Math.min(width ? width / img.width : 1, height ? height / img.height : 1, 1);
	if (ratio >= 1) return dataUrl;
	const canvas = document.createElement('canvas');
	canvas.width = Math.round(img.width * ratio);
	canvas.height = Math.round(img.height * ratio);
	canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height);
	return canvas.toDataURL('image/png');
}

const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript|x-sh|x-yaml|yaml|csv))/;

/**
 * The files attached to the next message (MessageInput.svelte's upload
 * handlers). Uploads go to the server (documents are processed for
 * retrieval, images kept as they are, after the optional scaling); a
 * temporary chat keeps nothing on the server, so its images travel as data
 * URLs and text files as their text. Web pages are fetched and processed by
 * the server; knowledge, notes and chats are added by reference.
 */
export function useAttachments({ temporary, selectedModels, models, chatId }: { temporary: boolean; selectedModels: string[]; models: ChatModel[]; chatId: string | null }) {
	const token = useAuthStore((s) => s.token) ?? '';
	const user = useAuthStore((s) => s.user);
	const config = useConfigStore((s) => s.config) as { file?: { max_size?: number | null; max_count?: number | null; image_compression?: { width?: number | null; height?: number | null } } } | null;
	const { settings } = useUserSettings();
	const [files, setFilesState] = useState<ChatFile[]>([]);
	const ref = useRef(files);
	const setFiles = useCallback((next: ChatFile[] | ((f: ChatFile[]) => ChatFile[])) => {
		ref.current = typeof next === 'function' ? next(ref.current) : next;
		setFilesState(ref.current);
	}, []);
	const patch = (itemId: string, p: Partial<ChatFile>) => setFiles((fs) => fs.map((f) => (f.itemId === itemId ? { ...f, ...p } : f)));
	const drop = (itemId: string) => setFiles((fs) => fs.filter((f) => f.itemId !== itemId));

	const uploadOne = useCallback(
		async (file: File) => {
			const maxSize = config?.file?.max_size ?? null;
			if (maxSize !== null && file.size > maxSize * 1024 * 1024) {
				toast.error(`File size should not exceed ${maxSize} MB.`);
				return;
			}
			if (file.size === 0) {
				toast.error('You cannot upload an empty file.');
				return;
			}
			const itemId = crypto.randomUUID();
			const image = file.type.startsWith('image/');
			if (image) {
				let url = await readAsDataUrl(file);
				const size = imageTargetSize(settings as Record<string, any> | null, config);
				if (size) url = await scaleImage(url, size.width, size.height).catch(() => url);
				if (temporary) {
					setFiles((fs) => [...fs, { itemId, type: 'image', url, name: file.name, status: 'uploaded' }]);
					return;
				}
				file = new File([await (await fetch(url)).blob()], file.name, { type: file.type });
			} else if (temporary) {
				if (!TEXT_TYPES.test(file.type) && !/\.(md|txt|csv|json|py|js|ts|html|css|ya?ml|xml|log)$/i.test(file.name)) {
					toast.error('Failed to extract content from the file.');
					return;
				}
				setFiles((fs) => [...fs, { itemId, id: crypto.randomUUID(), type: 'text', name: file.name, size: file.size, content: '', status: 'uploading' }]);
				const content = await file.text().catch(() => null);
				if (content === null) {
					toast.error('Failed to extract content from the file.');
					drop(itemId);
				} else patch(itemId, { content, status: 'uploaded' });
				return;
			}
			setFiles((fs) => [...fs, { itemId, type: 'file', file: '', id: null, url: '', name: file.name, collection_name: '', status: 'uploading', size: file.size, error: '', ...((settings as Record<string, unknown> | null)?.defaultUploadContext === 'full' ? { context: 'full' } : {}) }]);
			const language = (settings as { audio?: { stt?: { language?: string } } } | null)?.audio?.stt?.language;
			const metadata = (file.type.startsWith('audio/') || file.type.startsWith('video/')) && language ? { language } : chatId ? { chat_id: chatId } : null;
			try {
				const uploaded = await uploadFile(token, file, metadata, !image);
				if (!uploaded) throw new Error('Failed to upload file.');
				if (uploaded.error) toast.warning(`${uploaded.error}`);
				patch(itemId, { status: 'uploaded', file: uploaded, id: uploaded.id, url: `${uploaded.id}`, collection_name: uploaded.meta?.collection_name ?? uploaded.collection_name, content_type: uploaded.meta?.content_type ?? uploaded.content_type });
			} catch (e) {
				toast.error(`${e}`);
				drop(itemId);
			}
		},
		[token, config, settings, temporary, chatId, setFiles]
	);

	const addFiles = useCallback(
		(list: File[]) => {
			if (!canUploadFiles(user)) {
				toast.error('You do not have permission to upload files.');
				return;
			}
			const hasNonImage = list.some((f) => !f.type.startsWith('image/'));
			if (hasNonImage && !allCapable(selectedModels, models, 'file_upload')) {
				toast.error('Model(s) do not support file upload');
				return;
			}
			const maxCount = config?.file?.max_count ?? null;
			if (maxCount !== null && ref.current.length + list.length > maxCount) {
				toast.error(`You can only chat with a maximum of ${maxCount} file(s) at a time.`);
				return;
			}
			if (list.some((f) => f.type.startsWith('image/')) && !allCapable(selectedModels, models, 'vision')) toast.warning('Model(s) are not vision capable');
			for (const f of list) void uploadOne(f);
		},
		[user, selectedModels, models, config, uploadOne]
	);

	const addWeb = useCallback(
		async (urls: string[]) => {
			if (!canUploadWeb(user)) {
				toast.error('You do not have permission to upload web content.');
				return;
			}
			for (const url of urls) {
				const itemId = crypto.randomUUID();
				setFiles((fs) => [...fs, { itemId, type: 'text', name: url, collection_name: '', status: 'uploading', context: 'full', url, error: '' }]);
				try {
					const res = await processUrl(token, url);
					if (!res) throw new Error('Failed to process the page.');
					const f = res.file;
					if ((res.type === 'image' || res.type === 'file') && f) patch(itemId, { status: 'uploaded', name: res.name ?? url, collection_name: res.collection_name ?? f.meta?.collection_name, type: res.type, file: f, id: f.id, url: `${f.id}`, content_type: f.meta?.content_type, size: f.meta?.size });
					else patch(itemId, { status: 'uploaded', name: res.name ?? url, collection_name: res.collection_name, file: { data: { content: res.content }, meta: { name: res.name ?? url, source: res.url ?? url } } });
				} catch (e) {
					toast.error(`${e}`);
					drop(itemId);
				}
			}
		},
		[token, user, setFiles]
	);

	/** A knowledge base, knowledge file, note or chat, attached by reference. */
	const addItem = useCallback(
		(item: ChatFile) => {
			if (ref.current.some((f) => f.id && f.id === item.id)) return;
			setFiles((fs) => [...fs, { ...item, itemId: crypto.randomUUID(), status: 'processed' }]);
		},
		[setFiles]
	);

	return { files, setFiles, addFiles, addWeb, addItem, remove: drop, clear: () => setFiles([]) };
}
