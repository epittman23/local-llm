import { ChevronRight, Download, File as FileIcon, Folder, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Spinner } from '@/components/common/Spinner';
import { Tip } from '@/components/common/Tip';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { WEBUI_BASE_URL } from '@/lib/constants';
import { capitalizeFirstLetter, cn } from '@/lib/utils';
import { dayjs } from '@/lib/utils/dates';
import { formatFileSize } from '@/lib/utils/files';
import { type Breadcrumb, KB_DIR_MOVE, KB_FILE_MOVE, readMovePayload } from './knowledgeFiles';
import type { UploadingItem } from './useKnowledgeUploads';

export type KnowledgeFile = {
	id?: string;
	tempId?: string;
	name?: string;
	status?: string;
	meta?: { name?: string; size?: number };
	updated_at?: number;
	user?: { email?: string; name?: string };
};
export type KnowledgeDirectory = { id: string; name: string; created_at: number; updated_at: number };

const isMovePayload = (dt: DataTransfer | null) => Boolean(dt?.types.includes(KB_FILE_MOVE) || dt?.types.includes(KB_DIR_MOVE));

/** An inline rename field: Enter or blur commits, Escape cancels. Space is kept from bubbling to the row. */
function RenameInput({ initial, onCommit, onCancel }: { initial: string; onCommit: (name: string) => void; onCancel: () => void }) {
	const [value, setValue] = useState(initial);
	const ref = useRef<HTMLInputElement>(null);
	useEffect(() => ref.current?.select(), []);
	return (
		<input
			ref={ref}
			value={value}
			aria-label="Rename"
			className="w-full border-none bg-transparent text-xs outline-hidden"
			onChange={(e) => setValue(e.target.value)}
			onKeyDown={(e) => {
				if (e.key === 'Enter') onCommit(value);
				if (e.key === 'Escape') onCancel();
				if (e.key === ' ') e.stopPropagation();
			}}
			onBlur={() => onCommit(value)}
			onClick={(e) => e.stopPropagation()}
		/>
	);
}

/** Ports KnowledgeBase/KnowledgeBreadcrumbs.svelte: root > folder > folder, each a drop target for moves. */
export function KnowledgeBreadcrumbs({
	rootLabel,
	breadcrumbs,
	onNavigate,
	onMove
}: {
	rootLabel: string;
	breadcrumbs: Breadcrumb[];
	onNavigate: (directoryId: string | null) => void;
	onMove: (payload: { kind: 'file' | 'dir'; id: string }, targetDirectoryId: string | null) => void;
}) {
	const [over, setOver] = useState<number | null>(null);
	const el = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (el.current) el.current.scrollLeft = el.current.scrollWidth;
	});

	const dropProps = (index: number, target: string | null) => ({
		onDragOver: (e: React.DragEvent) => {
			if (!isMovePayload(e.dataTransfer)) return;
			e.preventDefault();
			e.stopPropagation();
			setOver(index);
		},
		onDragLeave: () => setOver((cur) => (cur === index ? null : cur)),
		onDrop: (e: React.DragEvent) => {
			e.preventDefault();
			e.stopPropagation();
			setOver(null);
			const payload = readMovePayload(e.dataTransfer);
			if (payload) onMove(payload, target);
		}
	});
	const crumbClass = (active: boolean, index: number) =>
		cn(
			'shrink-0 py-0.5 text-xs transition hover:underline',
			active ? 'text-foreground' : 'text-muted-foreground',
			over === index && 'bg-muted rounded-lg'
		);

	return (
		<div ref={el} className="flex min-w-0 flex-1 items-center overflow-x-auto">
			<button type="button" className={crumbClass(breadcrumbs.length === 0, -1)} onClick={() => onNavigate(null)} {...dropProps(-1, null)}>
				{rootLabel}
			</button>
			{breadcrumbs.map((crumb, i) => (
				<span key={crumb.id} className="flex items-center">
					<ChevronRight className="text-muted-foreground/50 mx-0.5 size-3 shrink-0" />
					<button
						type="button"
						className={crumbClass(i === breadcrumbs.length - 1, i)}
						onClick={() => onNavigate(crumb.id)}
						{...dropProps(i, crumb.id)}
					>
						{crumb.name}
					</button>
				</span>
			))}
		</div>
	);
}

const menuButton = 'hover:bg-muted rounded-full p-1 transition';

/**
 * Ports KnowledgeBase/Files.svelte and DirectoryRow.svelte: directories first,
 * then files (with in-flight uploads on top). Double-click or the menu renames;
 * rows drag onto a directory or a breadcrumb to move. Directory drops accept
 * only the app's own move payloads, so dropping an OS file here falls through to
 * the page-level upload handler.
 */
export function KnowledgeFileList({
	files,
	uploading,
	directories,
	writeAccess,
	selectedFileId,
	onSelect,
	onDeleteFile,
	onRenameFile,
	onOpenDirectory,
	onRenameDirectory,
	onDeleteDirectory,
	onMove
}: {
	files: KnowledgeFile[];
	uploading: UploadingItem[];
	directories: KnowledgeDirectory[];
	writeAccess: boolean;
	selectedFileId: string | null;
	onSelect: (fileId: string) => void;
	onDeleteFile: (fileId: string) => void;
	onRenameFile: (fileId: string, name: string) => void;
	onOpenDirectory: (id: string) => void;
	onRenameDirectory: (id: string, name: string) => void;
	onDeleteDirectory: (id: string) => void;
	onMove: (payload: { kind: 'file' | 'dir'; id: string }, targetDirectoryId: string | null) => void;
}) {
	const [renamingFile, setRenamingFile] = useState<string | null>(null);
	const [renamingDir, setRenamingDir] = useState<string | null>(null);
	const [dropOver, setDropOver] = useState<string | null>(null);

	return (
		<div role="list" className="flex max-h-full w-full flex-col gap-px">
			{directories.map((dir) => (
				<div
					key={dir.id}
					role="listitem"
					draggable
					className={cn('group hover:bg-muted/60 flex w-full cursor-pointer rounded-xl px-2 transition', dropOver === dir.id && 'bg-muted ring-1')}
					onDragStart={(e) => e.dataTransfer.setData(KB_DIR_MOVE, JSON.stringify({ dirId: dir.id }))}
					onDoubleClick={() => writeAccess && setRenamingDir(dir.id)}
					onDragOver={(e) => {
						if (!isMovePayload(e.dataTransfer)) return;
						e.preventDefault();
						e.stopPropagation();
						setDropOver(dir.id);
					}}
					onDragLeave={() => setDropOver(null)}
					onDrop={(e) => {
						e.preventDefault();
						e.stopPropagation();
						setDropOver(null);
						const payload = readMovePayload(e.dataTransfer);
						// A directory dropped on itself is a no-op.
						if (payload && !(payload.kind === 'dir' && payload.id === dir.id)) onMove(payload, dir.id);
					}}
				>
					<div className="flex items-center">
						<button type="button" className="rounded-full p-1" aria-label={`Open ${dir.name}`} onClick={() => onOpenDirectory(dir.id)}>
							<Folder className="size-3.5" />
						</button>
					</div>
					<button
						type="button"
						className="relative flex flex-1 items-center justify-between gap-1 rounded-xl p-2 text-left"
						onClick={() => renamingDir !== dir.id && onOpenDirectory(dir.id)}
					>
						<div className="line-clamp-1 text-xs">
							{renamingDir === dir.id ? (
								<RenameInput
									initial={dir.name}
									onCancel={() => setRenamingDir(null)}
									onCommit={(name) => {
										setRenamingDir(null);
										if (name.trim() && name !== dir.name) onRenameDirectory(dir.id, name.trim());
									}}
								/>
							) : (
								dir.name
							)}
						</div>
						{dir.updated_at && (
							<Tip content={dayjs(dir.updated_at * 1000).format('LLLL')}>
								<div className="text-muted-foreground/70 shrink-0 text-xs">{dayjs(dir.updated_at * 1000).fromNow()}</div>
							</Tip>
						)}
					</button>
					{writeAccess && (
						<div className="flex items-center">
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<button type="button" className={menuButton} aria-label={`${dir.name} menu`}>
										<MoreHorizontal className="size-3.5" />
									</button>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end" className="min-w-36">
									<DropdownMenuItem onSelect={() => setRenamingDir(dir.id)}>
										<Pencil />
										Rename
									</DropdownMenuItem>
									<DropdownMenuItem onSelect={() => onDeleteDirectory(dir.id)}>
										<Trash2 />
										Delete
									</DropdownMenuItem>
								</DropdownMenuContent>
							</DropdownMenu>
						</div>
					)}
				</div>
			))}

			{uploading.map((item) => (
				<div key={item.itemId} role="listitem" className="flex w-full items-center rounded-xl px-2 py-2 text-xs">
					<Spinner className="mr-2 size-3.5" />
					<span className="line-clamp-1">
						{item.name}
						{item.size ? <span className="text-muted-foreground ml-1 text-[0.6875rem]">{formatFileSize(item.size)}</span> : null}
					</span>
				</div>
			))}

			{files.map((file) => {
				const fileId = file.id ?? file.tempId;
				const name = file.name ?? file.meta?.name ?? '';
				const isUploading = file.status === 'uploading';
				return (
					<div
						key={fileId}
						role="listitem"
						draggable
						className={cn('flex w-full cursor-pointer rounded-xl px-2 transition hover:bg-muted/60', selectedFileId === fileId && 'bg-muted/60')}
						onDragStart={(e) => fileId && e.dataTransfer.setData(KB_FILE_MOVE, JSON.stringify({ fileId }))}
					>
						<div className="flex items-center">
							{isUploading ? (
								<Spinner className="size-3.5" />
							) : (
								<button type="button" className="rounded-full p-1" aria-label={`Open ${name}`} onClick={() => fileId && onSelect(fileId)}>
									<FileIcon className="size-3.5" />
								</button>
							)}
						</div>
						<button
							type="button"
							className="relative flex flex-1 items-center justify-between gap-1 rounded-xl p-2 text-left"
							onClick={() => renamingFile === null && fileId && onSelect(fileId)}
							onDoubleClick={() => writeAccess && setRenamingFile(fileId ?? null)}
						>
							<div className="line-clamp-1 text-xs">
								{renamingFile === fileId ? (
									<RenameInput
										initial={name}
										onCancel={() => setRenamingFile(null)}
										onCommit={(next) => {
											setRenamingFile(null);
											if (fileId && next.trim()) onRenameFile(fileId, next.trim());
										}}
									/>
								) : (
									<>
										{name}
										{file.meta?.size ? <span className="text-muted-foreground ml-1 text-[0.6875rem]">{formatFileSize(file.meta.size)}</span> : null}
									</>
								)}
							</div>
							<div className="flex shrink-0 items-center gap-2">
								{file.updated_at && (
									<Tip content={dayjs(file.updated_at * 1000).format('LLLL')}>
										<div className="text-muted-foreground/70 text-xs">{dayjs(file.updated_at * 1000).fromNow()}</div>
									</Tip>
								)}
								{file.user && (
									<Tip content={file.user.email ?? 'Deleted User'} side="top">
										<div className="text-muted-foreground shrink-0">
											By {capitalizeFirstLetter(file.user.name ?? file.user.email ?? 'Deleted User')}
										</div>
									</Tip>
								)}
							</div>
						</button>
						{writeAccess && (
							<div className="flex items-center">
								<DropdownMenu>
									<DropdownMenuTrigger asChild>
										<button type="button" className={menuButton} aria-label={`${name} menu`}>
											<MoreHorizontal className="size-3.5" />
										</button>
									</DropdownMenuTrigger>
									<DropdownMenuContent align="end" className="min-w-36">
										<DropdownMenuItem onSelect={() => setRenamingFile(fileId ?? null)}>
											<Pencil />
											Rename
										</DropdownMenuItem>
										<DropdownMenuItem onSelect={() => window.open(`${WEBUI_BASE_URL}/api/v1/files/${encodeURIComponent(fileId ?? '')}/content`, '_blank')}>
											<Download />
											Download
										</DropdownMenuItem>
										<DropdownMenuItem onSelect={() => fileId && onDeleteFile(fileId)}>
											<Trash2 />
											Delete
										</DropdownMenuItem>
									</DropdownMenuContent>
								</DropdownMenu>
							</div>
						)}
					</div>
				);
			})}
		</div>
	);
}
