import { Fragment } from 'react';
import { Tip } from '@/components/common/Tip';
import { Switch } from '@/components/ui/switch';
import { type Permissions as PermissionsShape, setPermission } from '@/lib/access/permissions';
import { useConfigStore } from '@/lib/stores/configStore';
import { type PermissionRow, layoutRows, permissionSections, showsDefaultHint, visibleRows } from './permissionRows';

/**
 * Ports admin/Users/Groups/Permissions.svelte. The rows themselves live in
 * permissionRows.ts; this only lays them out. A switch that is off but on in
 * the all-users defaults says so underneath ("will remain enabled"), because
 * group permissions only ever add to the defaults.
 */
export function Permissions({
	permissions,
	onChange,
	defaultPermissions
}: {
	permissions: PermissionsShape;
	onChange: (next: PermissionsShape) => void;
	defaultPermissions?: Partial<PermissionsShape>;
}) {
	const pluginsEnabled = Boolean(useConfigStore((s) => s.config?.features?.enable_plugins));
	const context = { pluginsEnabled };

	const renderRow = (row: PermissionRow) => {
		const label = row.nested ? (
			<div className="self-center text-xs">{row.label}</div>
		) : (
			<div className="self-center text-xs font-normal">{row.label}</div>
		);
		const control = (
			<Switch
				aria-label={row.label}
				checked={Boolean(permissions[row.group][row.key])}
				onCheckedChange={(checked) => onChange(setPermission(permissions, row.group, row.key, checked))}
			/>
		);
		const line = (
			<div className={`flex w-full justify-between ${row.nested ? '' : 'my-1'}`}>
				{label}
				{control}
			</div>
		);
		return (
			<>
				{row.warning ? <Tip content={row.warning}>{line}</Tip> : line}
				{showsDefaultHint(row, permissions, defaultPermissions) && (
					<div className="text-muted-foreground pb-0.5 text-xs">This is a default user permission and will remain enabled.</div>
				)}
			</>
		);
	};

	return (
		<div className="space-y-2">
			{permissionSections.map((section, sectionIdx) => {
				const rows = visibleRows(section, permissions, context);
				return (
					<Fragment key={section.title}>
						{sectionIdx > 0 && <hr className="border-border/40" />}
						<div>
							<div className="mb-2 text-sm font-normal">{section.title}</div>
							<div className="flex w-full flex-col">
								{layoutRows(rows).map((block) =>
									Array.isArray(block) ? (
										<div key={block[0].key} className="ml-2 flex flex-col gap-2 pt-0.5 pb-1">
											{block.map((row) => (
												<Fragment key={row.key}>{renderRow(row)}</Fragment>
											))}
										</div>
									) : (
										<div key={block.key} className="flex w-full flex-col">
											{renderRow(block)}
										</div>
									)
								)}
							</div>
						</div>
					</Fragment>
				);
			})}
		</div>
	);
}
