import { ChevronDown, FileDown, FileUp, Link2, Pencil } from 'lucide-react';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import type { WorkspaceAction } from '@/lib/stores/workspaceStore';

// Ports common/SplitCreateButton.svelte. The primary click runs the action
// whose id ends in `-new` (or, failing that, the first visible one); the
// chevron opens the rest. With exactly one action there is no menu at all.
// Icons are picked from the action id's suffix, same convention as the Svelte
// version, so a section only has to name its actions consistently.
function actionIcon(id: string) {
	if (id.endsWith('-new')) return Pencil;
	if (id.includes('-import-link')) return Link2;
	if (id.includes('-import')) return FileUp;
	if (id.includes('-export')) return FileDown;
	return Pencil;
}

export function SplitCreateButton({
	actions,
	label = 'Create'
}: {
	actions: WorkspaceAction[];
	label?: string;
}) {
	const navigate = useNavigate();
	const visible = actions.filter((action) => action.visible ?? true);
	const primary = visible.find((action) => action.id.endsWith('-new')) ?? visible[0] ?? null;

	const run = async (action: WorkspaceAction | null) => {
		if (!action) return;
		if (action.href) navigate(action.href);
		else await action.onClick?.();
	};

	if (visible.length === 0) return null;

	if (visible.length === 1) {
		return (
			<Button variant="outline" size="sm" onClick={() => run(primary)}>
				{label}
			</Button>
		);
	}

	return (
		<div className="flex overflow-hidden rounded-lg border">
			<Button
				variant="ghost"
				size="sm"
				className="rounded-none"
				onClick={() => run(primary)}
			>
				{label}
			</Button>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						variant="ghost"
						size="icon-sm"
						className="rounded-none border-l"
						aria-label="Open create menu"
					>
						<ChevronDown />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="min-w-40">
					{visible.map((action) => {
						const Icon = actionIcon(action.id);
						return (
							<DropdownMenuItem key={action.id} onSelect={() => run(action)}>
								<Icon />
								<span className="truncate">{action.label}</span>
							</DropdownMenuItem>
						);
					})}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}
