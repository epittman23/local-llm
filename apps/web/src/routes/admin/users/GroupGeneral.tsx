import { Textarea } from '@/components/ui/textarea';

type GroupData = { config?: { share?: boolean | string } } & Record<string, unknown>;

const toSelectValue = (share: unknown) => (share === undefined || share === null ? 'members' : String(share));
// The <select> speaks strings; the group stores false / 'members' / true.
const fromSelectValue = (value: string): boolean | string => (value === 'false' ? false : value === 'true' ? true : value);

/** Ports admin/Users/Groups/General.svelte: name, description, who may share to the group, delete. */
export function GroupGeneral({
	name,
	onNameChange,
	description,
	onDescriptionChange,
	data,
	onDataChange,
	edit,
	onDelete
}: {
	name: string;
	onNameChange: (name: string) => void;
	description: string;
	onDescriptionChange: (description: string) => void;
	data: GroupData;
	onDataChange: (data: GroupData) => void;
	edit: boolean;
	onDelete: () => void;
}) {
	return (
		<>
			<div className="flex gap-2">
				<div className="flex w-full flex-col">
					<label className="text-muted-foreground mb-0.5 text-xs" htmlFor="group-name">
						Name
					</label>
					<input
						id="group-name"
						className="placeholder:text-muted-foreground/50 w-full bg-transparent text-sm outline-hidden"
						type="text"
						value={name}
						onChange={(e) => onNameChange(e.target.value)}
						placeholder="Group Name"
						autoComplete="off"
						required
					/>
				</div>
			</div>

			<div className="mt-2 flex w-full flex-col">
				<label className="text-muted-foreground mb-1 text-xs" htmlFor="group-description">
					Description
				</label>
				<Textarea
					id="group-description"
					className="placeholder:text-muted-foreground/50 w-full resize-none border-0 bg-transparent px-0 text-sm shadow-none"
					rows={4}
					value={description}
					onChange={(e) => onDescriptionChange(e.target.value)}
					placeholder="Group Description"
				/>
			</div>

			<hr className="my-1" />

			<div className="mt-2 flex w-full flex-col">
				<div className="text-muted-foreground mb-1 text-xs">Setting</div>
				<div className="flex w-full justify-between">
					<label className="self-center text-xs" htmlFor="group-share">
						Who can share to this group
					</label>
					<div className="flex items-center gap-2 p-1">
						<select
							id="group-share"
							className="rounded-lg bg-transparent px-2 text-sm outline-hidden"
							value={toSelectValue(data?.config?.share)}
							onChange={(e) => onDataChange({ ...data, config: { ...(data?.config ?? {}), share: fromSelectValue(e.target.value) } })}
						>
							<option value="false">No one</option>
							<option value="members">Members</option>
							<option value="true">Anyone</option>
						</select>
					</div>
				</div>
			</div>

			{edit && (
				<div className="mt-2 flex w-full flex-col">
					<div className="text-muted-foreground mb-0.5 text-xs">Actions</div>
					<div className="flex-1">
						<button type="button" className="cursor-pointer bg-transparent text-xs hover:underline" onClick={onDelete}>
							Delete
						</button>
					</div>
				</div>
			)}
		</>
	);
}
