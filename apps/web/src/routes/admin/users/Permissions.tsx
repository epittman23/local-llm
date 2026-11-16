import { TriangleAlert } from 'lucide-react';
import { useId, useState } from 'react';
import { ListEmptyState, ListSearchBar } from '@/components/common/ListChrome';
import { Disclosure } from '@/components/settings/formFields';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { type Permissions as PermissionsShape, setPermission } from '@/lib/access/permissions';
import { useConfigStore } from '@/lib/stores/configStore';
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
 * permissionRows.ts; this only lays them out. Each is a checkbox with its
 * label and a one-line description, since the form is saved (FRM-5). One that
 * is off but on in the all-users defaults says so underneath, because group
 * permissions only ever add to the defaults.
 *
 * #1099: the six groups fold (the shared disclosure row, FRM-6), each heading
 * saying how many of its permissions differ from `baseline` (what Reset
 * restores), and a filter box finds one by its label or description, opening
 * every group that holds one.
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

	const renderRow = (row: PermissionRow) => {
		const boxId = `${id}-${row.group}-${row.key}`;
		return (
			<>
				<div className="flex min-w-0 items-start gap-2.5 py-1.5">
					<Checkbox
						id={boxId}
						className="mt-0.5"
						aria-describedby={row.description ? `${boxId}-description` : undefined}
						checked={Boolean(permissions[row.group][row.key])}
						onCheckedChange={(checked) => onChange(setPermission(permissions, row.group, row.key, checked === true))}
					/>
					<div className="min-w-0 flex-1">
						<Label htmlFor={boxId} className="text-body text-foreground-strong font-normal">
							{row.label}
						</Label>
						{row.description && (
							<p id={`${boxId}-description`} className="text-foreground-muted mt-0.5 text-dense">
								{row.description}
							</p>
						)}
					</div>
				</div>
				{row.warning && (
					<p className="text-warning text-dense flex items-start gap-1.5 ps-6.5 pb-1">
						<TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
						<span>{row.warning}</span>
					</p>
				)}
				{showsDefaultHint(row, permissions, defaultPermissions) && (
					<p className="text-foreground-muted text-dense ps-6.5 pb-1">
						On for every account by default, so this group's members keep it.
					</p>
				)}
			</>
		);
	};

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
						return (
							<section key={section.title} aria-label={section.title} className="border-b py-1 last:border-b-0">
								<Disclosure
									level={3}
									title={section.title}
									meta={
										<>
											<span className="text-foreground-muted text-dense">
												{filtering ? `${rows.length} of ${visible.length}` : visible.length}
											</span>
											{changed > 0 && <Badge variant="secondary">{changed} changed</Badge>}
										</>
									}
									open={expanded}
									onOpenChange={() => toggle(section.title)}
									className="mb-2"
								>
									<div className="flex flex-col">
										{layoutRows(rows).map((block) =>
											Array.isArray(block) ? (
												<div key={block[0].key} className="ms-2 flex flex-col border-s ps-4">
													{block.map((row) => (
														<div key={row.key}>{renderRow(row)}</div>
													))}
												</div>
											) : (
												<div key={block.key}>{renderRow(block)}</div>
											)
										)}
									</div>
								</Disclosure>
							</section>
						);
					})}
				</div>
			)}
		</div>
	);
}
