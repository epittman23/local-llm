import {
	ArrowDown,
	ArrowUp,
	Copy,
	Download,
	Eye,
	EyeOff,
	Globe,
	GripVertical,
	Link2,
	Lock,
	MoreHorizontal,
	Pencil
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Tip } from '@/components/common/Tip';
import { ProfileAvatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { RowButton } from '@/components/ui/row-button';
import { Switch } from '@/components/ui/switch';
import { WEBUI_API_BASE_URL } from '@/lib/constants';
import { cn } from '@/lib/utils';
import { accessLabel, isPublicModel, type ModelItem } from './adminModels';

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

/** A menu entry that is a setting: its name, a line on what it does, and a check while it is on (FRM-5). */
function SettingItem({
	checked,
	onSelect,
	label,
	description
}: {
	checked: boolean;
	onSelect: () => void;
	label: string;
	description: string;
}) {
	return (
		<DropdownMenuCheckboxItem checked={checked} onSelect={onSelect}>
			<span className="flex flex-col">
				<span>{label}</span>
				<span className="text-foreground-muted text-caption">{description}</span>
			</span>
		</DropdownMenuCheckboxItem>
	);
}

/**
 * One row of the admin model list (#1030). Line 1 is the name and its state as
 * badges (DAT-3: Hidden, Off, Default, Pinned; never a dimmed row, COL-2);
 * line 2 is its description, else its id in mono. The row opens the model; beside it are the menu
 * and the enable switch, which sits outside any tooltip so its own
 * `data-state` reaches the switch styles (#912).
 */
export function ModelRow({
	model,
	index,
	count,
	singleUser,
	pinsByDefault,
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
	/** Its place in its group, which is what Move up and Move down move within. */
	index: number;
	count: number;
	/** One account: no Private/Public label and no Make public (S4-D1, WRD-4). */
	singleUser: boolean;
	/**
	 * Pin by default and its badge, which only reach other accounts: off while
	 * Admin's one-account rule holds (S5-D12; the stored pins are kept).
	 */
	pinsByDefault: boolean;
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
	const name = model.name ?? model.id;
	const active = model.is_active ?? true;
	const hidden = Boolean(model.meta?.hidden);
	const isPublic = isPublicModel(model);
	const description = String(model.meta?.description ?? '').trim();
	const badges: ReactNode[] = [
		hidden && 'Hidden',
		!active && 'Off',
		isSelected && 'Default',
		pinsByDefault && isDefaultPinned && 'Pinned',
		!singleUser && accessLabel(model)
	]
		.filter((b): b is string => Boolean(b))
		.map((b) => (
			<Badge key={b} variant="secondary">
				<span className="sr-only">, </span>
				{b}
			</Badge>
		));

	return (
		<div
			data-model-row={model.id}
			data-dragging={dragging || undefined}
			className={cn(
				'hover:bg-muted/50 flex w-full min-w-0 items-center gap-1 rounded-xl px-2 py-1 transition',
				// The row being dragged is outlined rather than faded (COL-2); the drop target gets the focus edge.
				dragging && 'outline-border-control outline-dashed outline-1',
				dropTarget && 'ring-ring ring-1'
			)}
			onDragOver={onDragOver}
			onDrop={onDrop}
		>
			<Tip content={canReorder ? 'Drag to reorder' : 'Clear the search and filters to reorder'}>
				<span
					role="img"
					aria-label={canReorder ? `Drag ${name} to reorder` : 'Reordering is off while a search or filter is set'}
					draggable={canReorder}
					onDragStart={onDragStart}
					onDragEnd={onDragEnd}
					className={cn(
						'-ml-1 flex shrink-0 self-center',
						canReorder ? 'text-foreground-muted cursor-move' : 'text-foreground-disabled'
					)}
				>
					<GripVertical className="size-4" />
				</span>
			</Tip>

			<RowButton className="flex min-w-0 flex-1 items-center gap-2.5 px-1 py-1" onClick={handlers.open}>
				<ProfileAvatar
					src={`${WEBUI_API_BASE_URL}/models/model/profile/image?id=${encodeURIComponent(model.id)}`}
					name={name}
					className="size-7 shrink-0 self-center"
				/>
				{/* LAY-4: line 1 is the name and its state, line 2 the id, so the name keeps its width at 390. */}
				<span className="flex min-w-0 flex-1 flex-col">
					<span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
						<span className="min-w-0 truncate text-dense leading-5">{name}</span>
						{badges}
					</span>
					{description ? (
						<span className="text-foreground-muted min-w-0 truncate text-caption leading-4">{description}</span>
					) : (
						model.id !== name && (
							<span aria-hidden className="text-foreground-muted min-w-0 truncate font-mono text-caption leading-4">
								{model.id}
							</span>
						)
					)}
				</span>
			</RowButton>

			<div className="flex shrink-0 items-center gap-0.5 self-center">
				<Tip content="Edit">
					<Button
						variant="ghost"
						size="icon-sm"
						className="hidden sm:inline-flex"
						type="button"
						aria-label={`Edit ${name}`}
						onClick={handlers.open}
					>
						<Pencil aria-hidden className="size-3.5" />
					</Button>
				</Tip>

				<DropdownMenu>
					<Tip content="More">
						<DropdownMenuTrigger asChild>
							<Button variant="ghost" size="icon-sm" type="button" aria-label={`More actions for ${name}`}>
								<MoreHorizontal aria-hidden className="size-3.5" />
							</Button>
						</DropdownMenuTrigger>
					</Tip>
					{/* OVL-3: grouped settings, then the copies, then the order, then Hide last. */}
					<DropdownMenuContent align="end" className="w-auto min-w-60">
						<SettingItem
							checked={isSelected}
							onSelect={handlers.toggleSelected}
							label="Default for new chats"
							description="A new chat starts with this model."
						/>
						<SettingItem
							checked={isSidebarPinned}
							onSelect={handlers.togglePinnedInSidebar}
							label="Pin to sidebar"
							description="Shown in your sidebar."
						/>
						{pinsByDefault && (
							<SettingItem
								checked={isDefaultPinned}
								onSelect={handlers.toggleDefaultPinned}
								label="Pin by default"
								description="In the sidebar until you pin models yourself."
							/>
						)}
						{!singleUser && (
							<DropdownMenuItem onSelect={handlers.togglePrivacy}>
								{isPublic ? <Lock /> : <Globe />}
								{isPublic ? 'Make private' : 'Make public'}
							</DropdownMenuItem>
						)}
						<DropdownMenuSeparator />
						<DropdownMenuItem onSelect={handlers.copyLink}>
							<Link2 />
							Copy link
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
									Move up
								</DropdownMenuItem>
								<DropdownMenuItem disabled={index === count - 1} onSelect={handlers.moveDown}>
									<ArrowDown />
									Move down
								</DropdownMenuItem>
							</>
						)}
						<DropdownMenuSeparator />
						<DropdownMenuItem onSelect={handlers.toggleHidden}>
							{hidden ? <Eye /> : <EyeOff />}
							{hidden ? 'Show model' : 'Hide model'}
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>

				<span className="ml-1 flex h-6 items-center">
					<Switch aria-label={`Enable ${name}`} checked={active} onCheckedChange={handlers.toggleActive} />
				</span>
			</div>
		</div>
	);
}
