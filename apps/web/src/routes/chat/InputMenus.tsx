import { useQuery } from '@tanstack/react-query';
import { BookOpen, Code2, Globe, Image as ImageIcon, Link, MessageSquare, NotebookText, Plus, Search, Settings2, Upload, Wrench } from 'lucide-react';
import { type ReactNode, useRef, useState } from 'react';
import { AttachWebpageDialog } from '@/components/common/AttachWebpageDialog';
import { Spinner } from '@/components/common/Spinner';
import { Tip } from '@/components/common/Tip';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { getChatListBySearchText } from '@/lib/apis/chats';
import { searchKnowledgeBases, searchKnowledgeFiles } from '@/lib/apis/knowledge';
import { searchNotes } from '@/lib/apis/notes';
import type { FeatureButtons } from '@/lib/chat/attachments';
import type { ChatFile } from '@/lib/chat/history';
import { useAuthStore } from '@/lib/stores/authStore';
import { cn } from '@/lib/utils';
import { useDebouncedValue } from '@/lib/utils/useDebouncedValue';

const chip = 'text-muted-foreground hover:text-foreground hover:bg-muted flex items-center gap-1 rounded-full p-1.5 text-sm transition';

type PickKind = 'knowledge' | 'notes' | 'chats';

/** Knowledge bases and their files, notes, or chats, searchable, added by reference (InputMenu/Knowledge, Notes, Chats.svelte). */
function AttachPicker({ kind, onClose, onPick }: { kind: PickKind | null; onClose: () => void; onPick: (item: ChatFile) => void }) {
	const token = useAuthStore((s) => s.token) ?? '';
	const [query, setQuery] = useState('');
	const q = useDebouncedValue(query.trim(), 250);
	const results = useQuery({
		queryKey: ['attach-picker', kind, q],
		enabled: Boolean(kind),
		queryFn: async (): Promise<ChatFile[]> => {
			if (kind === 'knowledge') {
				const [bases, files] = await Promise.all([searchKnowledgeBases(token, q || null).catch(() => null), searchKnowledgeFiles(token, q || null).catch(() => null)]);
				return [
					...((Array.isArray(bases?.items) ? bases.items : []) as any[]).map((b) => ({ ...b, type: 'collection', description: 'Collection' })),
					...((Array.isArray(files?.items) ? files.items : []) as any[]).map((f) => ({ ...f, type: 'file', name: f.filename, description: f.collection?.name ?? 'File' }))
				];
			}
			if (kind === 'notes') {
				const notes = (await searchNotes(token, q || null).catch(() => null))?.items;
				return ((Array.isArray(notes) ? notes : []) as any[]).map((n) => ({ id: n.id, name: n.title, type: 'note', description: 'Note' }));
			}
			const chats = await getChatListBySearchText(token, q || '', 1).catch(() => []);
			return ((Array.isArray(chats) ? chats : []) as any[]).map((c) => ({ id: c.id, name: c.title, type: 'chat', collection_name: '', description: 'Chat' }));
		}
	});
	const title = kind === 'knowledge' ? 'Attach Knowledge' : kind === 'notes' ? 'Attach Notes' : 'Reference Chats';
	return (
		<Dialog open={Boolean(kind)} onOpenChange={(o) => !o && onClose()}>
			<DialogContent className="max-w-md p-3">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription className="sr-only">Search and choose what to attach</DialogDescription>
				</DialogHeader>
				<div className="relative">
					<Search className="text-muted-foreground absolute top-2.5 left-2.5 size-4" />
					<Input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" aria-label={`Search ${kind ?? ''}`} className="pl-8" />
				</div>
				<div className="max-h-80 overflow-y-auto" role="listbox" aria-label={title}>
					{results.isLoading ? (
						<div className="flex justify-center py-6">
							<Spinner className="size-4" />
						</div>
					) : !results.data?.length ? (
						<p className="text-muted-foreground py-6 text-center text-sm">No results found</p>
					) : (
						results.data.map((item) => (
							<button
								key={`${item.type}-${item.id}`}
								type="button"
								role="option"
								aria-selected={false}
								className="hover:bg-muted flex w-full items-center justify-between gap-2 rounded-lg px-2 py-2 text-left text-sm"
								onClick={() => {
									onPick(item);
									onClose();
								}}
							>
								<span className="truncate">{String(item.name ?? '')}</span>
								<span className="text-muted-foreground shrink-0 text-xs">{String(item.description ?? '')}</span>
							</button>
						))
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}

/** Ports MessageInput/InputMenu.svelte: upload files, attach a web page, knowledge, notes or chats. */
export function AttachMenu({ onFiles, onWeb, onItem, canUpload, canWeb, notesEnabled }: { onFiles: (files: File[]) => void; onWeb: (urls: string[]) => void; onItem: (item: ChatFile) => void; canUpload: boolean; canWeb: boolean; notesEnabled: boolean }) {
	const input = useRef<HTMLInputElement>(null);
	const [web, setWeb] = useState(false);
	const [picker, setPicker] = useState<PickKind | null>(null);
	return (
		<>
			<input
				ref={input}
				type="file"
				multiple
				hidden
				aria-label="Upload files"
				onChange={(e) => {
					onFiles(Array.from(e.target.files ?? []));
					e.target.value = '';
				}}
			/>
			<DropdownMenu>
				<Tip content="More">
					<DropdownMenuTrigger asChild>
						<button type="button" aria-label="More" className={chip}>
							<Plus className="size-4" />
						</button>
					</DropdownMenuTrigger>
				</Tip>
				<DropdownMenuContent align="start" side="top" className="w-56">
					<DropdownMenuItem disabled={!canUpload} onSelect={() => input.current?.click()}>
						<Upload /> Upload Files
					</DropdownMenuItem>
					<DropdownMenuItem disabled={!canWeb} onSelect={() => setWeb(true)}>
						<Link /> Attach Webpage
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem onSelect={() => setPicker('knowledge')}>
						<BookOpen /> Attach Knowledge
					</DropdownMenuItem>
					{notesEnabled && (
						<DropdownMenuItem onSelect={() => setPicker('notes')}>
							<NotebookText /> Attach Notes
						</DropdownMenuItem>
					)}
					<DropdownMenuItem onSelect={() => setPicker('chats')}>
						<MessageSquare /> Reference Chats
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			<AttachWebpageDialog open={web} onOpenChange={setWeb} onSubmit={onWeb} />
			<AttachPicker kind={picker} onClose={() => setPicker(null)} onPick={onItem} />
		</>
	);
}

export type Toggles = { webSearch: boolean; imageGeneration: boolean; codeInterpreter: boolean };
type Tool = { id: string; name: string; meta?: { description?: string } };

/**
 * Ports MessageInput/IntegrationsMenu.svelte: the tools to offer the model
 * and the Web Search, Image and Code Interpreter switches (each shown only
 * when the server, the user's permissions and every selected model allow it).
 * Switched-on features also show as chips beside the menu, to switch off.
 */
export function IntegrationsMenu({ tools, toolIds, onToolIds, buttons, toggles, onToggles }: { tools: Tool[]; toolIds: string[]; onToolIds: (ids: string[]) => void; buttons: FeatureButtons; toggles: Toggles; onToggles: (t: Toggles) => void }) {
	const [toolQuery, setToolQuery] = useState('');
	const anyFeature = buttons.webSearch || buttons.imageGeneration || buttons.codeInterpreter;
	if (!tools.length && !anyFeature) return null;
	const shown = tools.filter((t) => t.name.toLowerCase().includes(toolQuery.toLowerCase()));
	const feature = (key: keyof Toggles, label: string, icon: ReactNode) => (
		<label className="hover:bg-muted flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm">
			{icon}
			<span className="flex-1">{label}</span>
			<Switch aria-label={label} checked={toggles[key]} onCheckedChange={(v) => onToggles({ ...toggles, [key]: v })} />
		</label>
	);
	const active: [keyof Toggles, string, ReactNode][] = [
		['webSearch', 'Web Search', <Globe key="w" className="size-3.5" />],
		['imageGeneration', 'Image', <ImageIcon key="i" className="size-3.5" />],
		['codeInterpreter', 'Code Interpreter', <Code2 key="c" className="size-3.5" />]
	];
	return (
		<>
			<DropdownMenu>
				<Tip content="Integrations">
					<DropdownMenuTrigger asChild>
						<button type="button" aria-label="Integrations" className={cn(chip, toolIds.length > 0 && 'text-foreground')}>
							<Settings2 className="size-4" />
							{toolIds.length > 0 && <span className="text-xs">{toolIds.length}</span>}
						</button>
					</DropdownMenuTrigger>
				</Tip>
				<DropdownMenuContent align="start" side="top" className="w-64" onKeyDown={(e) => e.stopPropagation()}>
					{buttons.webSearch && feature('webSearch', 'Web Search', <Globe className="size-4" />)}
					{buttons.imageGeneration && feature('imageGeneration', 'Image', <ImageIcon className="size-4" />)}
					{buttons.codeInterpreter && feature('codeInterpreter', 'Code Interpreter', <Code2 className="size-4" />)}
					{tools.length > 0 && (
						<>
							{anyFeature && <DropdownMenuSeparator />}
							<DropdownMenuLabel className="flex items-center gap-1">
								<Wrench className="size-3.5" /> Tools
							</DropdownMenuLabel>
							{tools.length > 6 && <Input value={toolQuery} onChange={(e) => setToolQuery(e.target.value)} placeholder="Search tools" aria-label="Search tools" className="mx-1 mb-1 h-7 w-[calc(100%-0.5rem)]" />}
							<div className="max-h-56 overflow-y-auto">
								{shown.map((t) => (
									<label key={t.id} className="hover:bg-muted flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm">
										<span className="min-w-0 flex-1 truncate" title={t.meta?.description}>
											{t.name}
										</span>
										<Switch aria-label={t.name} checked={toolIds.includes(t.id)} onCheckedChange={(v) => onToolIds(v ? [...toolIds, t.id] : toolIds.filter((x) => x !== t.id))} />
									</label>
								))}
								{!shown.length && <p className="text-muted-foreground px-2 py-2 text-xs">No tools found</p>}
							</div>
						</>
					)}
				</DropdownMenuContent>
			</DropdownMenu>
			{active
				.filter(([k]) => toggles[k] && buttons[k])
				.map(([k, label, icon]) => (
					<button key={k} type="button" aria-label={`${label} (on)`} className="flex items-center gap-1 rounded-full bg-blue-500/10 px-2 py-1 text-xs text-blue-600 dark:text-blue-400" onClick={() => onToggles({ ...toggles, [k]: false })}>
						{icon}
						{label}
					</button>
				))}
		</>
	);
}
