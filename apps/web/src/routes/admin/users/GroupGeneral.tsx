import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FieldMessage, fieldProps } from '@/components/ui/field-message';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

type GroupData = { config?: { share?: boolean | string } } & Record<string, unknown>;

const toSelectValue = (share: unknown) => (share === undefined || share === null ? 'members' : String(share));
// The select speaks strings; the group stores false / 'members' / true.
const fromSelectValue = (value: string): boolean | string =>
	value === 'false' ? false : value === 'true' ? true : value;

/**
 * Ports admin/Users/Groups/General.svelte: name, description, who may share to
 * the group, delete. #1099/#933: labelled, edged fields; a missing name shows
 * under Name (FRM-2); Delete group names what it deletes (ACT-2).
 */
export function GroupGeneral({
	nameId,
	name,
	nameError,
	onNameChange,
	description,
	onDescriptionChange,
	data,
	onDataChange,
	edit,
	onDelete
}: {
	nameId: string;
	name: string;
	nameError?: string | null;
	onNameChange: (name: string) => void;
	description: string;
	onDescriptionChange: (description: string) => void;
	data: GroupData;
	onDataChange: (data: GroupData) => void;
	edit: boolean;
	onDelete: () => void;
}) {
	const shareId = `${nameId}-share`;
	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-col gap-1.5">
				<Label htmlFor={nameId}>Name</Label>
				<Input
					id={nameId}
					value={name}
					onChange={(e) => onNameChange(e.target.value)}
					placeholder="Analysts"
					autoComplete="off"
					{...fieldProps(`${nameId}-msg`, { error: nameError })}
				/>
				<FieldMessage id={`${nameId}-msg`} error={nameError} />
			</div>

			<div className="flex flex-col gap-1.5">
				<Label htmlFor={`${nameId}-description`}>
					Description <span className="text-foreground-muted font-normal">(optional)</span>
				</Label>
				<Textarea
					id={`${nameId}-description`}
					rows={3}
					value={description}
					onChange={(e) => onDescriptionChange(e.target.value)}
					placeholder="Who is in this group, and why"
				/>
			</div>

			<div className="flex flex-col gap-1.5">
				<Label htmlFor={shareId}>Who can share with this group</Label>
				<Select
					value={toSelectValue(data?.config?.share)}
					onValueChange={(value) =>
						onDataChange({ ...data, config: { ...(data?.config ?? {}), share: fromSelectValue(value) } })
					}
				>
					<SelectTrigger id={shareId} className="w-full sm:w-48" aria-describedby={`${shareId}-msg`}>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="false">No one</SelectItem>
						<SelectItem value="members">Its members</SelectItem>
						<SelectItem value="true">Anyone</SelectItem>
					</SelectContent>
				</Select>
				<FieldMessage
					id={`${shareId}-msg`}
					help="Who may pick this group when sharing a model, prompt or other item."
				/>
			</div>

			{edit && (
				<div className="flex flex-col items-start gap-1.5 border-t pt-4">
					<Button variant="destructive" type="button" onClick={onDelete}>
						<Trash2 aria-hidden data-icon="inline-start" />
						Delete group
					</Button>
				</div>
			)}
		</div>
	);
}
