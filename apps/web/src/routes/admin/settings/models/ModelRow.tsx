import {
	Check,
	Copy,
	Download,
	Eye,
	EyeOff,
	GripVertical,
	Link2,
	ArrowDown,
	ArrowUp,
	Globe,
	Lock,
	MoreHorizontal,
	Pencil,
	Pin,
	PinOff
} from 'lucide-react';
import { SafeMarkdown } from '@/components/common/SafeMarkdown';
import { Tip } from '@/components/common/Tip';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';
import { WEBUI_API_BASE_URL } from '@/lib/constants';
import { cn } from '@/lib/utils';
import { DEFAULT_PROFILE_IMAGE } from '@/routes/workspace/models/modelEditorLogic';
import { type ModelItem, accessLabel, isPublicModel } from './adminModels';

const accessClass = {
	Public: 'text-emerald-700 dark:text-emerald-400',
	Shared: 'text-sky-700 dark:text-sky-400',
	Private: 'text-muted-foreground'
} as const;
const iconButton =
	'text-muted-foreground hover:bg-muted hover:text-foreground flex size-7 items-center justify-center rounded-xl transition-colors';

export type RowHandlers = {
	open: () => void;
	toggleActive: () => void;
	toggleHidden: () => void;
	toggleSelected: () => void;
	toggleDefaultPinned: () => void;
	togglePrivacy: () => void;
	togglePinnedInSidebar: () => void;
	copyLink: () => void;
	clone: () => void;
	exportModel: () => void;
	moveUp: () => void;
	moveDown: () => void;
};

/** A model's description for the hover card: its own text, else the Ollama digest, else its id. */
const describe = (m: ModelItem) =>
	m.meta?.description
		? m.meta.description
		: m.ollama?.digest
			? `${m.ollama.digest} **(${m.ollama.modified_at})**`
			: m.id;

/** One row of the admin model list. */
export function ModelRow({
	model,
	index,
	count,
	shiftKey,
	canReorder,
	isSelected,
	isDefaultPinned,
	isSidebarPinned,
	dragging,
	dropTarget,
	handlers,
	onDragStart,
	onDragOver,
	onDrop,
	onDragEnd
}: {
	model: ModelItem;
	index: number;
	count: number;
	shiftKey: boolean;
	canReorder: boolean;
	isSelected: boolean;
	isDefaultPinned: boolean;
	isSidebarPinned: boolean;
	dragging: boolean;
	dropTarget: boolean;
	handlers: RowHandlers;
	onDragStart: (event: React.DragEvent) => void;
	onDragOver: (event: React.DragEvent) => void;
	onDrop: (event: React.DragEvent) => void;
	onDragEnd: () => void;
}) {
	const active = model.is_active ?? true;
	const hidden = Boolean(model.meta?.hidden);
	const isPublic = isPublicModel(model);
	const access = accessLabel(model);

	return (
		<div
			data-model-row={model.id}
			className={cn(
				'hover:bg-muted/50 flex w-full rounded-xl px-2 py-1 transition',
				hidden && 'opacity-50',
				dragging && 'opacity-40',
				dropTarget && 'ring-ring ring-1'
			)}
			onDragOver={onDragOver}
			onDrop={onDrop}
		>
			<div className="text-muted-foreground/60 -ml-1 flex items-center self-center pr-1">
				<Tip content={canReorder ? 'Drag to reorder' : 'Clear filters to reorder'}>
					<span
						role="img"
						aria-label={
							canReorder ? `Drag ${model.name ?? model.id} to reorder` : 'Reordering is off while filters are set'
						}
						draggable={canReorder}
						onDragStart={onDragStart}
						onDragEnd={onDragEnd}
						className={cn('flex', canReorder ? 'cursor-move' : 'opacity-40')}
					>
						<GripVertical className="size-4" />
					</span>
				</Tip>
			</div>

			<button
				type="button"
				className="group/item flex min-w-0 flex-1 cursor-pointer gap-2.5 text-left"
				onClick={handlers.open}
			>
				<div className={cn('self-center rounded-xl', !active && 'opacity-50')}>
					<img
						src={`${WEBUI_API_BASE_URL}/models/model/profile/image?id=${encodeURIComponent(model.id)}`}
						alt=""
						className="size-7 rounded-xl object-cover"
						loading="lazy"
						decoding="async"
						onError={(e) => {
							if (e.currentTarget.src !== DEFAULT_PROFILE_IMAGE) e.currentTarget.src = DEFAULT_PROFILE_IMAGE;
						}}
					/>
				</div>
				<div className={cn('flex min-w-0 flex-1 self-center pr-1', !active && 'text-muted-foreground')}>
					<Tip content={<SafeMarkdown text={describe(model)} className="text-background" />} side="top">
						<div className="flex min-w-0 items-center gap-1.5 text-[0.8125rem] leading-4">
							<span className="min-w-0 truncate">{model.name ?? model.id}</span>
							<span className={cn('shrink-0 text-[0.6875rem]', accessClass[access])}>{access}</span>
							{isSelected && <span className="text-muted-foreground shrink-0 text-[0.6875rem]">Selected</span>}
							{isDefaultPinned && <span className="text-muted-foreground shrink-0 text-[0.6875rem]">Pinned</span>}
						</div>
					</Tip>
				</div>
			</button>

			<div className="flex shrink-0 items-center gap-0.5 self-center">
				{shiftKey && (
					<>
						<Tip content={hidden ? 'Show' : 'Hide'}>
							<button
								type="button"
								className={iconButton}
								aria-label={hidden ? 'Show' : 'Hide'}
								onClick={handlers.toggleHidden}
							>
								{hidden ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
							</button>
						</Tip>
						<Tip content={isSelected ? 'Remove Selected Model' : 'Set as Selected Model'}>
							<button
								type="button"
								className={cn(iconButton, isSelected && 'text-foreground')}
								aria-label={isSelected ? 'Remove Selected Model' : 'Set as Selected Model'}
								onClick={handlers.toggleSelected}
							>
								<Check className="size-3.5" />
							</button>
						</Tip>
						<Tip content={isDefaultPinned ? 'Remove Pinned Model' : 'Set as Pinned Model'}>
							<button
								type="button"
								className={cn(iconButton, isDefaultPinned && 'text-foreground')}
								aria-label={isDefaultPinned ? 'Remove Pinned Model' : 'Set as Pinned Model'}
								onClick={handlers.toggleDefaultPinned}
							>
								{isDefaultPinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
							</button>
						</Tip>
						<Tip content={isPublic ? 'Make Private' : 'Make Public'}>
							<button
								type="button"
								className={iconButton}
								aria-label={isPublic ? 'Make Private' : 'Make Public'}
								onClick={handlers.togglePrivacy}
							>
								{isPublic ? <Lock className="size-3.5" /> : <Globe className="size-3.5" />}
							</button>
						</Tip>
					</>
				)}

				<button
					type="button"
					className={cn(iconButton, 'hidden sm:flex')}
					aria-label={`Edit ${model.name ?? model.id}`}
					onClick={handlers.open}
				>
					<Pencil className="size-3.5" />
				</button>

				<DropdownMenu>
					<Tip content="More">
						<DropdownMenuTrigger asChild>
							<button type="button" className={iconButton} aria-label={`More actions for ${model.name ?? model.id}`}>
								<MoreHorizontal className="size-3.5" />
							</button>
						</DropdownMenuTrigger>
					</Tip>
					<DropdownMenuContent align="end" className="w-auto min-w-44">
						<DropdownMenuItem onSelect={handlers.toggleHidden}>
							{hidden ? <EyeOff /> : <Eye />}
							{hidden ? 'Show Model' : 'Hide Model'}
						</DropdownMenuItem>
						<DropdownMenuItem onSelect={handlers.toggleSelected}>
							<Check />
							{isSelected ? 'Remove Selected Model' : 'Set as Selected Model'}
						</DropdownMenuItem>
						<DropdownMenuItem onSelect={handlers.toggleDefaultPinned}>
							{isDefaultPinned ? <PinOff /> : <Pin />}
							{isDefaultPinned ? 'Remove Pinned Model' : 'Set as Pinned Model'}
						</DropdownMenuItem>
						<DropdownMenuItem onSelect={handlers.togglePrivacy}>
							{isPublic ? <Lock /> : <Globe />}
							{isPublic ? 'Make Private' : 'Make Public'}
						</DropdownMenuItem>
						<DropdownMenuItem onSelect={handlers.togglePinnedInSidebar}>
							{isSidebarPinned ? <PinOff /> : <Pin />}
							{isSidebarPinned ? 'Hide from Sidebar' : 'Keep in Sidebar'}
						</DropdownMenuItem>
						<DropdownMenuItem onSelect={handlers.copyLink}>
							<Link2 />
							Copy Link
						</DropdownMenuItem>
						{active && (
							<DropdownMenuItem onSelect={handlers.clone}>
								<Copy />
								Clone
							</DropdownMenuItem>
						)}
						<DropdownMenuItem onSelect={handlers.exportModel}>
							<Download />
							Export
						</DropdownMenuItem>
						{canReorder && (
							<>
								<DropdownMenuSeparator />
								<DropdownMenuItem disabled={index === 0} onSelect={handlers.moveUp}>
									<ArrowUp />
									Move Up
								</DropdownMenuItem>
								<DropdownMenuItem disabled={index === count - 1} onSelect={handlers.moveDown}>
									<ArrowDown />
									Move Down
								</DropdownMenuItem>
							</>
						)}
					</DropdownMenuContent>
				</DropdownMenu>

				<div className="ml-1">
					<Tip content={active ? 'Enabled' : 'Disabled'}>
						<Switch
							checked={active}
							onCheckedChange={handlers.toggleActive}
							aria-label={`${model.name ?? model.id} enabled`}
						/>
					</Tip>
				</div>
			</div>
		</div>
	);
}
