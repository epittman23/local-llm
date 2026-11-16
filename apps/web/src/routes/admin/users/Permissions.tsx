import { ChevronRight, TriangleAlert } from 'lucide-react';
import { useId, useState } from 'react';
import { ListEmptyState, ListSearchBar } from '@/components/common/ListChrome';
import { SettingRow } from '@/components/settings/controls';
import { Badge } from '@/components/ui/badge';
import { RowButton } from '@/components/ui/row-button';
import { Switch } from '@/components/ui/switch';
import { type Permissions as PermissionsShape, setPermission } from '@/lib/access/permissions';
import { useConfigStore } from '@/lib/stores/configStore';
import { cn } from '@/lib/utils';
import {
	changedRows,
	layoutRows,
	matchingRows,
	type PermissionRow,
	permissionSections,
	showsDefaultHint,
	visibleRows
} from './permissionRows';

/**
 * Ports admin/Users/Groups/Permissions.svelte. The rows themselves live in
 * permissionRows.ts; this only lays them out. A switch that is off but on in
 * the all-users defaults says so underneath, because group permissions only
 * ever add to the defaults.
 *
 * #1099: the six groups fold, each heading saying how many of its switches
 * differ from `baseline` (what Reset restores), and a filter box finds a
 * switch by its label or description, opening every group that holds one.
 */
export function Permissions({
	permissions,
	onChange,
	defaultPermissions,
	baseline
}: {
	permissions: PermissionsShape;
	onChange: (next: PermissionsShape) => void;
	defaultPermissions?: Partial<PermissionsShape>;
	/** What the changed counts compare against: the values Reset restores. */
	baseline: PermissionsShape;
}) {
	const pluginsEnabled = Boolean(useConfigStore((s) => s.config?.features?.enable_plugins));
	const context = { pluginsEnabled };
	const [query, setQuery] = useState('');
	const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
	const id = useId();
	const filtering = query.trim() !== '';

	// Typing a filter opens every group, so each match is in view; clearing it folds them again.
	const changeQuery = (value: string) => {
		setQuery(value);
		setOpen(value.trim() ? new Set(permissionSections.map((s) => s.title)) : new Set());
	};

	const toggle = (title: string) =>
		setOpen((prev) => {
			const next = new Set(prev);
			if (next.has(title)) next.delete(title);
			else next.add(title);
			return next;
		});

	const renderRow = (row: PermissionRow) => (
		<>
			<SettingRow
				label={row.label}
				labelClassName={row.nested ? 'font-normal' : undefined}
				description={row.description}
			>
				{(labelId) => (
					<Switch
						aria-labelledby={labelId}
						checked={Boolean(permissions[row.group][row.key])}
						onCheckedChange={(checked) => onChange(setPermission(permissions, row.group, row.key, checked))}
					/>
				)}
			</SettingRow>
			{row.warning && (
				<p className="text-warning text-dense flex items-start gap-1.5 pb-1">
					<TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
					<span>{row.warning}</span>
				</p>
			)}
			{showsDefaultHint(row, permissions, defaultPermissions) && (
				<p className="text-foreground-muted text-dense pb-1">
					On for every account by default, so this group's members keep it.
				</p>
			)}
		</>
	);

	const sections = permissionSections
		.map((section) => {
			const visible = visibleRows(section, permissions, context);
			return {
				section,
				visible,
				rows: filtering ? matchingRows(visible, query) : visible,
				changed: changedRows(visible, permissions, baseline).length
			};
		})
		.filter(({ rows }) => rows.length > 0);

	return (
		<div className="flex flex-col gap-3">
			<ListSearchBar value={query} onChange={changeQuery} placeholder="Filter permissions" />
			{sections.length === 0 ? (
				<ListEmptyState title="No permissions" query={query} onClear={() => changeQuery('')} />
			) : (
				<div className="flex flex-col">
					{sections.map(({ section, rows, visible, changed }) => {
						const expanded = open.has(section.title);
						const panelId = `${id}-${section.title.replace(/\W+/g, '-')}`;
						return (
							<section key={section.title} aria-label={section.title} className="border-b last:border-b-0">
								<h3>
									<RowButton
										className="flex items-center gap-2 px-2 py-2.5"
										aria-expanded={expanded}
										aria-controls={panelId}
										onClick={() => toggle(section.title)}
									>
										<ChevronRight
											aria-hidden
											className={cn('size-4 shrink-0 transition-transform', expanded && 'rotate-90')}
										/>
										<span className="text-foreground-strong font-strong min-w-0 flex-1 truncate">{section.title}</span>
										<span className="text-foreground-muted text-dense shrink-0">
											{filtering ? `${rows.length} of ${visible.length}` : visible.length}
										</span>
										{changed > 0 && (
											<Badge variant="secondary" className="shrink-0">
												{changed} changed
											</Badge>
										)}
									</RowButton>
								</h3>
								{expanded && (
									<div id={panelId} className="flex flex-col gap-1 px-2 pb-3">
										{layoutRows(rows).map((block) =>
											Array.isArray(block) ? (
												<div key={block[0].key} className="ms-3 flex flex-col gap-1 border-s ps-3">
													{block.map((row) => (
														<div key={row.key}>{renderRow(row)}</div>
													))}
												</div>
											) : (
												<div key={block.key}>{renderRow(block)}</div>
											)
										)}
									</div>
								)}
							</section>
						);
					})}
				</div>
			)}
		</div>
	);
}
