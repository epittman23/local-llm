import { AccessControl } from '@/components/common/AccessControl';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle
} from '@/components/ui/dialog';
import type { AccessGrant, Permission } from '@/lib/access/accessGrants';

/** Ports workspace/common/AccessControlModal.svelte: AccessControl in a small dialog. */
export function AccessControlModal({
	open,
	onOpenChange,
	accessGrants,
	onChange,
	accessRoles = ['read'],
	share = true,
	sharePublic = true,
	shareOpen = false,
	shareUsers = true
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	accessGrants: AccessGrant[];
	onChange: (grants: AccessGrant[]) => void;
	accessRoles?: Permission[];
	share?: boolean;
	sharePublic?: boolean;
	shareOpen?: boolean;
	shareUsers?: boolean;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Access Control</DialogTitle>
					<DialogDescription className="sr-only">
						Choose who can see and edit this item.
					</DialogDescription>
				</DialogHeader>
				<AccessControl
					accessGrants={accessGrants}
					onChange={onChange}
					accessRoles={accessRoles}
					share={share}
					sharePublic={sharePublic}
					shareOpen={shareOpen}
					shareUsers={shareUsers}
				/>
			</DialogContent>
		</Dialog>
	);
}
