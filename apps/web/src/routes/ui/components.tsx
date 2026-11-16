import {
	CircleAlertIcon,
	CircleCheckIcon,
	CopyIcon,
	EllipsisIcon,
	GlobeIcon,
	Loader2Icon,
	LockIcon,
	MessageSquareIcon,
	PencilIcon,
	PlusIcon,
	RotateCwIcon,
	SearchIcon,
	SquarePenIcon,
	Trash2Icon,
	TriangleAlertIcon
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { toast } from 'sonner';
import { Markdown } from '@/components/chat/markdown/Markdown';
import { ReplyOrb, ReplySteps } from '@/components/chat/ReplySteps';
import { toastFailure } from '@/components/common/failureToast';
import { Gone } from '@/components/common/Gone';
import { ListEmptyState } from '@/components/common/ListChrome';
import { LoadFailed } from '@/components/common/LoadFailed';
import { SETTINGS_PANEL_ID, SettingsNav, settingsTabId } from '@/components/settings/SettingsNav';
import type { SettingsTab } from '@/components/settings/settingsTabs';
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger
} from '@/components/ui/alert-dialog';
import { AppMark } from '@/components/ui/app-mark';
import { ProfileAvatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger
} from '@/components/ui/dialog';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { ImageButton } from '@/components/ui/image-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RowButton } from '@/components/ui/row-button';
import { SaveBar } from '@/components/ui/save-bar';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LineTextarea, Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ServerUnreachableError } from '@/lib/apis/errors';
import type { History, Message } from '@/lib/chat/history';
import { THEMES, type ThemeId } from '@/lib/theme';
import { useUnsavedChanges } from '@/lib/ui/useUnsavedChanges';
import { SubTabs } from '@/routes/admin/AdminLayout';
import { ResponseMessage } from '@/routes/chat/ChatMessages';
import { ErrorReply } from '@/routes/chat/ErrorReply';
import { ModelRow } from '@/routes/chat/ModelSelector';
import type { ChatModel } from '@/routes/chat/useModels';
import {
	ChartDemo,
	ConnectionUrlDemo,
	DisclosureDemo,
	OpeningTableDemo,
	StatusNoticeDemo,
	TallDialogDemo
} from './adminDemos';
import { Example, Field, PageHeader, Panel, Section } from './parts';
import { CodeEditorFieldDemo, FailedRowDemo, ListMatchCountDemo, RowStateDemo } from './workspaceDemos';

// The second half of /ui: the shared components (components/ui) under the
// standard, and the patterns built from them. Every name and figure is
// invented (demo-a, example00a1, round numbers) so nothing here reads as a
// measurement; the kinds of thing are the ones this app holds.

type Status = 'success' | 'warning' | 'danger' | 'neutral';

const STATUS_BADGE: Record<
	Status,
	{ icon: typeof CircleCheckIcon | null; variant: 'success' | 'warning' | 'danger' | 'secondary' }
> = {
	success: { icon: CircleCheckIcon, variant: 'success' },
	warning: { icon: TriangleAlertIcon, variant: 'warning' },
	danger: { icon: CircleAlertIcon, variant: 'danger' },
	neutral: { icon: null, variant: 'secondary' }
};

/** COL-3, DAT-3: a status is the shared Badge's status variant, a word with an icon. Never the colour alone. */
export function StatusBadge({ status, children }: { status: Status; children: string }) {
	const { icon: Icon, variant } = STATUS_BADGE[status];
	return (
		<Badge variant={variant}>
			{Icon && <Icon aria-hidden data-icon="inline-start" />}
			{children}
		</Badge>
	);
}

export function ActionsSection() {
	const [saving, setSaving] = useState(false);
	const [openRow, setOpenRow] = useState('a');
	const timer = useRef<number | undefined>(undefined);
	useEffect(() => () => window.clearTimeout(timer.current), []);
	const save = () => {
		setSaving(true);
		timer.current = window.setTimeout(() => {
			setSaving(false);
			toast.success('Profile saved');
		}, 900);
	};
	return (
		<Section
			id="actions"
			title="Actions"
			lead="A view has one filled button: the thing you most likely came to do. Everything else is quieter. A button's label says what will happen, and the confirmation that follows uses the same word."
			rules={['ACT-1', 'ACT-2', 'ACT-4', 'ACT-5', 'ACT-6', 'ACT-7', 'ACT-8', 'A11Y-1', 'FBK-3']}
		>
			<Example
				title="The five kinds"
				note="Primary, secondary, quiet, destructive and link. Press Tab to see the focus indicator: the same 2 px chalk-blue outline on every control in the app."
			>
				<div className="flex flex-wrap items-center gap-3">
					<Button>Start serving</Button>
					<Button variant="outline">Edit profile</Button>
					<Button variant="ghost">Cancel</Button>
					<Button variant="destructive">Delete profile</Button>
					<Button variant="link">View the log</Button>
				</div>
			</Example>
			<Example
				title="States"
				note="A busy button says what it is doing, shows a spinner and cannot be pressed twice. A disabled one is visibly unavailable but still readable, and the reason sits next to it."
			>
				<div className="flex flex-wrap items-center gap-3">
					<Button onClick={save} disabled={saving} aria-busy={saving}>
						{saving && <Loader2Icon aria-hidden className="animate-spin" />}
						{saving ? 'Saving…' : 'Save profile'}
					</Button>
					<Button disabled>Run tests</Button>
					<span className="text-foreground-muted text-dense">
						Nothing is being served, so there is nothing to test.
					</span>
				</div>
			</Example>
			<Example
				title="Disabled switches"
				note="A disabled switch still shows whether it is on: its edge turns to a divider, and the on track or the off knob turns the disabled grey. The same happens inside a disabled fieldset, which is how a tab that saves at once holds its controls while a save is in flight."
			>
				<Panel className="flex max-w-[40rem] flex-col gap-4">
					<DemoSwitchRow
						id="ui-demo-switch-off"
						label="Image generation"
						help="Off on this install. Turn it on in Admin > Settings > Images."
						checked={false}
						disabled
					/>
					<DemoSwitchRow
						id="ui-demo-switch-on"
						label="Code interpreter"
						help="On for everyone. The server's configuration sets it, so it can't be changed here."
						checked
						disabled
					/>
					<fieldset disabled aria-busy className="flex flex-col gap-4 border-t pt-4">
						<legend className="sr-only">Connections, while a change saves</legend>
						<p className="text-foreground-muted flex items-center gap-2 text-dense">
							<Loader2Icon aria-hidden className="size-3.5 animate-spin" />
							Saving…
						</p>
						<DemoSwitchRow id="ui-demo-fieldset-on" label="OpenAI-compatible connections" checked />
						<DemoSwitchRow id="ui-demo-fieldset-off" label="Ollama" checked={false} />
					</fieldset>
				</Panel>
			</Example>
			<Example
				title="Icon buttons"
				note="An icon on its own always has a name: read by a screen reader, shown as a tooltip on hover and on focus."
			>
				<div className="flex flex-wrap items-center gap-2">
					{[
						{ label: 'Copy answer', icon: CopyIcon },
						{ label: 'Edit message', icon: PencilIcon },
						{ label: 'Try again', icon: RotateCwIcon }
					].map(({ label, icon: Icon }) => (
						<Tooltip key={label}>
							<TooltipTrigger asChild>
								<Button variant="ghost" size="icon" aria-label={label} onClick={() => toast.success(`${label}: done`)}>
									<Icon aria-hidden />
								</Button>
							</TooltipTrigger>
							<TooltipContent>{label}</TooltipContent>
						</Tooltip>
					))}
					<Button size="sm" variant="outline">
						<PlusIcon aria-hidden />
						Compact, for toolbars
					</Button>
				</div>
			</Example>
			<Example
				title="Rows and pictures"
				note="A whole row that opens something is a row button, not a stretched button: it takes the full width, highlights on hover and marks the open row. A picture you press to change it is an image button: the picture fills it, and an icon appears over it on hover and on focus. A model or person without a picture of its own shows its initials on surface-3 (the profile avatar), never a stock image. The rows' box keeps 4 px of room inside its edge, as a list that scrolls must, so the focus outline is never cut."
			>
				<div className="grid max-w-[40rem] gap-6 sm:grid-cols-[1fr_auto]">
					<div className="border-border flex flex-col gap-1 rounded-panel border p-1">
						{[
							{ id: 'a', name: 'demo-a', note: 'All layers on the GPU' },
							{ id: 'b', name: 'demo-b', note: '20 layers on the GPU' }
						].map((row) => (
							<RowButton
								key={row.id}
								aria-current={row.id === openRow ? 'true' : undefined}
								className="flex items-center gap-3 px-3 py-2"
								onClick={() => setOpenRow(row.id)}
							>
								<ProfileAvatar name={row.name} />
								<span className="min-w-0">
									<span className="font-strong block truncate">{row.name}</span>
									<span className="text-dense text-foreground-muted block truncate">{row.note}</span>
								</span>
							</RowButton>
						))}
					</div>
					<ImageButton
						shape="circle"
						aria-label="Change the profile picture"
						className="size-16 self-center"
						overlay={<PencilIcon />}
						onClick={() => toast.success('Choose a picture')}
					>
						<ProfileAvatar name="Ada Lovelace" className="text-title size-full" />
					</ImageButton>
				</div>
			</Example>
		</Section>
	);
}

export function FormsSection() {
	const [name, setName] = useState('demo-a');
	const [context, setContext] = useState('8192');
	const [saved, setSaved] = useState({ name: 'demo-a', context: '8192' });
	// FRM-2: a field is judged once the person has left it or tried to save.
	const [contextChecked, setContextChecked] = useState(false);
	const [autoTitle, setAutoTitle] = useState(true);
	// FRM-4: the theme here is only the demo's own value; the page's theme is the switch at the top.
	const [theme, setTheme] = useState<ThemeId>('dark');
	const [shareWith, setShareWith] = useState('');
	const contextField = useRef<HTMLInputElement>(null);
	const dirty = name !== saved.name || context !== saved.context;
	const contextValid = /^\d+$/.test(context) && Number(context) >= 512 && Number(context) <= 32768;
	const contextError =
		contextChecked && !contextValid ? 'Enter a whole number of tokens between 512 and 32768.' : undefined;
	// FRM-3: leaving the page with unsaved changes asks first.
	const guard = useUnsavedChanges(dirty);
	return (
		<Section
			id="forms"
			title="Forms"
			lead="Every field has a visible edge, a label that stays put, and its help or its error directly underneath. A form either saves when you press Save and tells you while changes are pending, or applies each change at once and says so. Never both without saying."
			rules={['FRM-1', 'FRM-2', 'FRM-3', 'FRM-4', 'FRM-5', 'FRM-6', 'FBK-1', 'COL-6', 'ACT-5']}
		>
			<Example
				title="A form that saves on request"
				note="Change a value: the save bar at the bottom (the shared SaveBar) reports unsaved changes and offers to discard them, and leaving the page (a link, Back, a reload) asks 'Discard changes?' first: the shared useUnsavedChanges guard. Type 40000 as the context size and leave the field: the error replaces the help line in place (the shared FieldMessage), in words that say how to fix it. The checkbox's box is 16 px, but it answers a click across 40 by 32 px, and 44 by 44 on touch."
			>
				{guard.dialog}
				<Panel className="max-w-[40rem]">
					<form
						className="flex flex-col gap-4"
						onSubmit={(event) => {
							event.preventDefault();
							setContextChecked(true);
							if (!contextValid) {
								contextField.current?.focus();
								return;
							}
							setSaved({ name, context });
							toast.success('Profile saved');
						}}
						noValidate
					>
						<Field label="Profile name" help="Shown in the profile picker and recorded with every run.">
							{(props) => <Input {...props} value={name} onChange={(e) => setName(e.target.value)} />}
						</Field>
						<Field label="Context size, tokens" error={contextError} help="512 to 32768.">
							{(props) => (
								<Input
									{...props}
									ref={contextField}
									inputMode="numeric"
									value={context}
									onChange={(e) => setContext(e.target.value)}
									onBlur={() => setContextChecked(true)}
								/>
							)}
						</Field>
						<Field label="Offload" help="How much of the model runs on the GPU.">
							{(props) => (
								<Select defaultValue="partial">
									<SelectTrigger {...props} className="w-full">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="full">All layers on the GPU</SelectItem>
										<SelectItem value="partial">20 layers on the GPU</SelectItem>
										<SelectItem value="none">CPU only</SelectItem>
									</SelectContent>
								</Select>
							)}
						</Field>
						<Field label="Notes" optional>
							{(props) => <Textarea {...props} placeholder="What this profile is for" rows={3} />}
						</Field>
						<Field
							label="First measured"
							optional
							help="A native control: it follows the dark theme because the page declares its colour scheme."
						>
							{(props) => <Input {...props} type="date" defaultValue="2026-10-24" className="w-48" />}
						</Field>
						<div className="flex items-center gap-2">
							<Checkbox id="ui-demo-mmap" defaultChecked />
							<Label htmlFor="ui-demo-mmap" className="text-body font-normal">
								Map the weights file into memory
							</Label>
						</div>
						<SaveBar
							dirty={dirty}
							saveLabel="Save profile"
							onDiscard={() => {
								setName(saved.name);
								setContext(saved.context);
								setContextChecked(false);
							}}
						/>
					</form>
				</Panel>
			</Example>
			<Example
				title="A name that may be long"
				note="A name field is one line that wraps and grows to show the whole name, however long (the shared LineTextarea). Enter does what it does in an input, and a pasted line break becomes a space."
			>
				<Panel className="max-w-[24rem]">
					<Field label="Tool name">
						{(props) => (
							<LineTextarea
								{...props}
								defaultValue="Regression diagnostics with residual plots, leverage, Cook's distance, variance inflation factors and a Breusch-Pagan test for heteroscedasticity"
							/>
						)}
					</Field>
				</Panel>
			</Example>
			<Example
				title="A folded group of settings"
				note="One full-width row: the group's name, an optional second line and count, and a chevron that turns. Opened, it grows inside a frame in the page's own scroller and comes into view; it never scrolls on its own."
			>
				<DisclosureDemo />
			</Example>
			<Example
				title="A URL with Test connection"
				note="It checks for http:// or https:// first, then says under the URL what it found: the model count in the success colour, or the server's reason in the danger colour with the field marked invalid. An edit clears the result."
			>
				<ConnectionUrlDemo />
			</Example>
			<Example
				title="A native select"
				note="New code uses the shared Select. The native selects pages still have get the same edge, fill, corner and compact height from the standard, and 16 px type on touch, without classes of their own."
			>
				<Panel className="flex max-w-[40rem] flex-wrap items-end gap-6">
					<Field label="Shared Select, compact">
						{(props) => (
							<Select defaultValue="updated">
								<SelectTrigger {...props} size="sm" className="w-44">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="updated">Recently updated</SelectItem>
									<SelectItem value="name">Name</SelectItem>
								</SelectContent>
							</Select>
						)}
					</Field>
					<Field label="Native select">
						{(props) => (
							<select {...props} defaultValue="updated" className="w-44">
								<option value="updated">Recently updated</option>
								<option value="name">Name</option>
							</select>
						)}
					</Field>
				</Panel>
			</Example>
			<Example
				title="Two to five choices that apply at once"
				note="A segmented control: words with line icons, one radio group. Tab reaches the chosen segment, the arrow keys move and choose, and on a phone the segments share one row. It can also hold a required choice with nothing chosen yet, confirmed by a separate button, and a segment that cannot be chosen says why underneath."
			>
				<Panel className="flex max-w-[40rem] flex-col gap-6">
					<div className="flex flex-col gap-2">
						<Label id="ui-demo-theme-label" className="text-body font-strong">
							Theme
						</Label>
						<SegmentedControl
							aria-labelledby="ui-demo-theme-label"
							value={theme}
							onValueChange={setTheme}
							options={THEMES.map((t) => ({ value: t.id, label: t.label, icon: t.icon }))}
						/>
						<p className="text-foreground-muted text-dense" role="status">
							{THEMES.find((t) => t.id === theme)?.label}. Applied.
						</p>
					</div>
					<div className="flex flex-col gap-2">
						<Label id="ui-demo-share-label" className="text-body font-strong">
							Who can open the link
						</Label>
						<SegmentedControl
							aria-labelledby="ui-demo-share-label"
							aria-describedby="ui-demo-share-help"
							value={shareWith}
							onValueChange={setShareWith}
							options={[
								{ value: 'anyone', label: 'Anyone with the link', icon: GlobeIcon, disabled: true },
								{ value: 'me', label: 'Only me (signed in)', icon: LockIcon }
							]}
						/>
						<p id="ui-demo-share-help" className="text-foreground-muted text-dense">
							Your sharing permissions do not allow links that anyone can open.
						</p>
						<div>
							<Button disabled={!shareWith} onClick={() => toast.success('Link created and copied')}>
								Create and copy link
							</Button>
						</div>
					</div>
				</Panel>
			</Example>
			<Example
				title="A setting that applies at once"
				note="A switch is for a setting that takes effect immediately. Its label names the setting, not its current state, and the line below confirms what happened."
			>
				<Panel className="flex max-w-[40rem] items-start justify-between gap-6">
					<div>
						<Label htmlFor="ui-demo-titles" className="text-body font-strong">
							Name new chats automatically
						</Label>
						<p className="text-foreground-muted text-dense mt-1" role="status">
							{autoTitle ? 'On. Applied.' : 'Off. Applied.'}
						</p>
					</div>
					<Switch id="ui-demo-titles" checked={autoTitle} onCheckedChange={setAutoTitle} />
				</Panel>
			</Example>
		</Section>
	);
}

const RUNS = [
	{
		config: 'example00a1',
		profile: 'demo-a',
		status: 'success' as const,
		word: 'Passed',
		pass: 0.75,
		tps: 12.5,
		vram: 4000
	},
	{
		config: 'example00b2',
		profile: 'demo-b',
		status: 'warning' as const,
		word: 'Throttled',
		pass: 0.5,
		tps: 2.5,
		vram: 6000
	},
	{
		config: 'example00c3',
		profile: 'demo-c',
		status: 'danger' as const,
		word: 'Failed',
		pass: null,
		tps: null,
		vram: 2000
	}
];

export function DataSection() {
	return (
		<Section
			id="data"
			title="Tables and figures"
			lead="Numbers are right-aligned in tabular figures with one precision per column, the unit lives in the column heading, and a missing value is a dash, not a blank or a zero. Identifiers are monospaced and can be copied."
			rules={['DAT-1', 'DAT-2', 'DAT-3', 'DAT-4', 'DAT-6', 'NAV-5', 'TYP-6', 'COL-2', 'COL-8', 'A11Y-2', 'A11Y-4']}
		>
			<Example
				title="A results table"
				note="On a narrow screen the table scrolls inside its own frame, a shadow marks the edge that hides columns, and Tab reaches the frame so the arrow keys scroll it. The page never scrolls sideways."
			>
				<div className="border-border overflow-hidden rounded-panel border">
					<Table aria-label="Runs" className="text-dense min-w-[38rem]">
						<TableHeader className="bg-surface-1">
							<TableRow>
								<TableHead scope="col">Configuration</TableHead>
								<TableHead scope="col">Profile</TableHead>
								<TableHead scope="col">Status</TableHead>
								<TableHead scope="col" className="text-right">
									Pass rate, %
								</TableHead>
								<TableHead scope="col" className="text-right">
									Generation, tokens/s
								</TableHead>
								<TableHead scope="col" className="text-right">
									Peak VRAM, MiB
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{RUNS.map((run) => (
								<TableRow key={run.config}>
									<TableCell>
										<span className="flex items-center gap-1">
											<code>{run.config}</code>
											<Button
												variant="ghost"
												size="icon-sm"
												aria-label={`Copy configuration ${run.config}`}
												onClick={() => toast.success('Configuration id copied')}
											>
												<CopyIcon aria-hidden />
											</Button>
										</span>
									</TableCell>
									<TableCell>{run.profile}</TableCell>
									<TableCell>
										<StatusBadge status={run.status}>{run.word}</StatusBadge>
									</TableCell>
									<TableCell className="text-right">{run.pass === null ? '–' : (run.pass * 100).toFixed(1)}</TableCell>
									<TableCell className="text-right">{run.tps === null ? '–' : run.tps.toFixed(1)}</TableCell>
									<TableCell className="text-right">{run.vram.toLocaleString('en-US')}</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			</Example>
			<Example
				title="Status"
				note="Four meanings, each a word with an icon: the shared Badge's success, warning and danger variants, and secondary for a state that is neither good nor bad."
			>
				<div className="flex flex-wrap items-center gap-2">
					<StatusBadge status="success">Passed</StatusBadge>
					<StatusBadge status="warning">Throttled</StatusBadge>
					<StatusBadge status="danger">Failed</StatusBadge>
					<StatusBadge status="neutral">Not run</StatusBadge>
				</div>
			</Example>
			<Example
				title="A row's state"
				note="Off, Hidden and Read only are words on the row's first line, never a faded row. The switch is named for its row ('Enable Code reviewer'), not for its state, and its row's second line says what the thing is."
			>
				<Panel className="max-w-[40rem]">
					<RowStateDemo />
				</Panel>
			</Example>
			<Example
				title="A narrowed list's count"
				note="While a search narrows a list, the list says how many of the whole it shows ('2 of 6 prompts', the shared ListMatchCount); the tab keeps the whole count. Nothing matching says so and offers Clear search."
			>
				<ListMatchCountDemo />
			</Example>
			<Example
				title="Rows that open, headings that sort"
				note="A click anywhere on a row opens it, except on a control in it; the name is a button, the keyboard's way in. A sortable heading is a button, and only the open sort's heading carries aria-sort."
			>
				<OpeningTableDemo />
			</Example>
			<Example
				title="A chart"
				note="A legend names each line's colour, the y axis has a title and round ticks, and Show as table gives every value to the keyboard and to a screen reader. The tooltip opens away from the nearer edge."
			>
				<ChartDemo />
			</Example>
		</Section>
	);
}

/** A few of Settings' tabs, for the vertical tab list's demo. */
const DEMO_SETTINGS_TABS: SettingsTab[] = [
	{ id: 'general', title: 'General', group: 'Basics', keywords: [] },
	{ id: 'interface', title: 'Interface', group: 'Basics', keywords: [] },
	{ id: 'data_controls', title: 'Data controls', group: 'Data', keywords: [] },
	{ id: 'admin:general', title: 'Server: General', group: 'System', keywords: [] },
	{ id: 'admin:connections', title: 'Server: Connections', group: 'System', keywords: [] }
];

/** Invented chats for the search demo. */
const DEMO_CHATS = [
	{ group: 'Today', titles: ['Variance of a sample mean', 'Plot residuals for demo-a'] },
	{ group: 'Previous 7 days', titles: ['Bootstrap confidence interval', 'Refactor the CSV reader'] }
];

/** A labelled switch with its help line, for the disabled states (ACT-5). */
function DemoSwitchRow({
	id,
	label,
	help,
	checked,
	disabled
}: {
	id: string;
	label: string;
	help?: string;
	checked: boolean;
	disabled?: boolean;
}) {
	return (
		<div className="flex items-start justify-between gap-6">
			<div>
				<Label htmlFor={id} className="text-body font-strong">
					{label}
				</Label>
				{help && (
					<p id={`${id}-help`} className="text-foreground-muted mt-1 text-dense">
						{help}
					</p>
				)}
			</div>
			<Switch id={id} checked={checked} disabled={disabled} aria-describedby={help ? `${id}-help` : undefined} />
		</div>
	);
}

const DEMO_SUB_TABS = [
	{ id: 'overview', label: 'Overview', count: '12' },
	{ id: 'groups', label: 'Groups', count: '3' },
	{ id: 'permissions', label: 'Default permissions' }
];

export function NavigationSection() {
	const [settingsTab, setSettingsTab] = useState('general');
	// The sub-tabs demo opens its tabs by the address's hash, so the page neither moves nor leaves.
	const { hash } = useLocation();
	const subTab = DEMO_SUB_TABS.find((t) => hash === `#ui-subtab-${t.id}`)?.id ?? 'overview';
	const [picked, setPicked] = useState('demo-coder');
	const settingsTitle = DEMO_SETTINGS_TABS.find((t) => t.id === settingsTab)?.title ?? '';
	return (
		<Section
			id="navigation"
			title="Pages and navigation"
			lead="Every page opens the same way: its name, one sentence about what it is for, and its main action on the right. Sibling views are tabs, and the open tab is unmistakable. A list you choose from moves with the arrow keys."
			rules={['LAY-5', 'NAV-2', 'NAV-5', 'WRD-3']}
		>
			<Example
				title="The mark"
				note="local-llm's mark at its three sizes: 20, 24 and 32 px. Beside the name it is decorative; standing in for the name, it is named."
			>
				<div className="flex flex-wrap items-center gap-6">
					<AppMark size={20} />
					<AppMark size={24} />
					<AppMark size={32} />
					<span className="flex items-center gap-2">
						<AppMark size={24} />
						<span className="text-body font-title">local-llm</span>
					</span>
				</div>
			</Example>
			<Example title="Page header and tabs">
				<Panel>
					<PageHeader
						as="h4"
						title="Knowledge"
						description="Collections of files a model can search while it answers."
						action={
							<Button>
								<PlusIcon aria-hidden />
								New collection
							</Button>
						}
					/>
					<Tabs defaultValue="files" className="mt-6">
						<TabsList variant="line">
							<TabsTrigger value="files">Files</TabsTrigger>
							<TabsTrigger value="settings">Settings</TabsTrigger>
							<TabsTrigger value="history">History</TabsTrigger>
						</TabsList>
						<TabsContent value="files" className="text-foreground-muted pt-4">
							Three files, last changed today.
						</TabsContent>
						<TabsContent value="settings" className="text-foreground-muted pt-4">
							How files are split and searched.
						</TabsContent>
						<TabsContent value="history" className="text-foreground-muted pt-4">
							Every upload and deletion.
						</TabsContent>
					</Tabs>
				</Panel>
			</Example>
			<Example
				title="A section's sub-tabs"
				note="Admin > Users and Evaluations: a strip of links above the section's content, a navigation landmark named for its section, the open one marked as the current page, and counts as secondary badges. A strip too wide for the screen scrolls sideways, with a fade at the edge that hides more."
			>
				<Panel className="max-w-[40rem] px-0">
					<SubTabs
						label="Users sections"
						active={subTab}
						tabs={DEMO_SUB_TABS.map((t) => ({ ...t, to: `#ui-subtab-${t.id}` }))}
					/>
					<p className="text-foreground-muted px-4 pt-4">
						The {DEMO_SUB_TABS.find((t) => t.id === subTab)?.label} section.
					</p>
				</Panel>
			</Example>
			<Example
				title="A vertical tab list"
				note="Settings' tab list: one tab list in two halves, with group captions that a screen reader skips. Up, Down, Home and End move between tabs; Enter opens one. A name that repeats carries its half, so this General is read as Server: General."
			>
				<Panel className="grid max-w-[40rem] gap-4 sm:grid-cols-[14rem_1fr]">
					<SettingsNav tabs={DEMO_SETTINGS_TABS} selected={settingsTab} onSelect={setSettingsTab} className="px-0" />
					<div
						id={SETTINGS_PANEL_ID}
						role="tabpanel"
						aria-labelledby={settingsTabId(settingsTab)}
						className="text-foreground-muted"
					>
						The {settingsTitle} tab's settings.
					</div>
				</Panel>
			</Example>
			<Example
				title="A list you choose from by keyboard"
				note="Search: the field keeps focus while the arrow keys move the highlight, Enter opens the highlighted chat, and the first item is highlighted whenever the list fills."
			>
				<Panel className="max-w-[32rem]">
					<Command label="Search chats" className="gap-2">
						<CommandInput placeholder="Search chats" />
						<CommandList>
							<CommandEmpty>No chats match. Check the spelling, or search archived chats.</CommandEmpty>
							{DEMO_CHATS.map(({ group, titles }) => (
								<CommandGroup key={group} heading={group}>
									{titles.map((title) => (
										<CommandItem key={title} value={title} onSelect={() => toast.success(`Opened “${title}”`)}>
											<MessageSquareIcon aria-hidden className="text-foreground-muted" />
											<span className="truncate">{title}</span>
										</CommandItem>
									))}
								</CommandGroup>
							))}
						</CommandList>
					</Command>
				</Panel>
			</Example>
			<Example
				title="The model picker's rows"
				note="Each row is left aligned: the model's name over a muted second line, its description or, for a workspace entry, the model it wraps in mono. The current one is checked. Ctrl+Shift+M opens the picker in a chat."
			>
				<Panel className="max-w-[32rem]">
					<Command label="Choose a model" className="gap-2">
						<CommandInput placeholder="Search models" />
						<CommandList>
							<CommandEmpty>No model matches.</CommandEmpty>
							{DEMO_MODELS.map((m) => (
								<CommandItem key={m.id} value={m.id} keywords={[m.name]} onSelect={() => setPicked(m.id)}>
									<ModelRow model={m} current={m.id === picked} />
								</CommandItem>
							))}
						</CommandList>
					</Command>
				</Panel>
			</Example>
		</Section>
	);
}

const DEMO_MODELS: ChatModel[] = [
	{
		id: 'demo-coder',
		name: 'Coder',
		info: {
			meta: { description: 'Writes, reviews and debugs code.' },
			base_model_id: 'qwen/qwen-2.5-coder-32b-instruct'
		}
	},
	{ id: 'demo-math', name: 'Math and statistics', info: { base_model_id: 'qwen/qwen3.6-27b' } }
];

export function FeedbackSection() {
	return (
		<Section
			id="feedback"
			title="Feedback and overlays"
			lead="A message appears where the thing it is about is. A toast only confirms something that already finished; an error stays until you have dealt with it and says what to do. Escape closes the top layer only, and focus returns to what opened it."
			rules={['FBK-1', 'FBK-2', 'FBK-4', 'STA-4', 'COL-3', 'ACT-3', 'OVL-1', 'OVL-2', 'OVL-3', 'NAV-4']}
		>
			<Example
				title="Toasts"
				note="Success leaves on its own after four seconds. A failure stays, says what went wrong, and offers the next step. A failed request's toast is the shared toastFailure: the sentence says what failed, and the server's own words wait behind a closed Details."
			>
				<div className="flex flex-wrap gap-3">
					<Button variant="outline" onClick={() => toast.success('Copied to the clipboard')}>
						Show a confirmation
					</Button>
					<Button
						variant="outline"
						onClick={() =>
							toast.error('The file was not uploaded', {
								description: 'notes-2026.pdf is 62 MB. The limit is 50 MB.',
								duration: Number.POSITIVE_INFINITY,
								closeButton: true,
								action: { label: 'Choose another file', onClick: () => undefined }
							})
						}
					>
						Show a failure
					</Button>
					<Button
						variant="outline"
						onClick={() => toastFailure('Couldn’t save “Weekly summary”. Try again.', { detail: 'database is locked' })}
					>
						Show a save failure
					</Button>
				</div>
			</Example>
			<Example title="Inline message" note="A condition that lasts is stated in place, not in a toast.">
				<div className="border-warning/50 flex max-w-[40rem] items-start gap-3 rounded-panel border p-3" role="status">
					<TriangleAlertIcon aria-hidden className="text-warning mt-0.5 size-4 shrink-0" />
					<div>
						<p className="font-strong">The code sandbox is not running</p>
						<p className="text-foreground-muted text-dense mt-0.5">
							Run buttons are hidden until it starts. Start it with <code>make backend</code>.
						</p>
					</div>
				</div>
			</Example>
			<Example
				title="A section's state"
				note="At the top of the section it describes: an icon and a title in the status colour, what it means and what to do as sentences, one action, and the server's own words behind Details. It is not help text."
			>
				<StatusNoticeDemo />
			</Example>
			<Example
				title="A tall dialog"
				note="Never taller than the viewport less 1 rem each side: its fields scroll in DialogBody while its title and buttons stay in view. Try it at 390 px."
			>
				<TallDialogDemo />
			</Example>
			<Example
				title="Dialog, destructive confirmation and menu"
				note="Open each with the keyboard: focus moves inside, Escape closes it, and focus comes back to the button. The confirmation names the thing and the consequence, starts on Cancel, and its action is the danger colour."
			>
				<div className="flex flex-wrap gap-3">
					<Dialog>
						<DialogTrigger asChild>
							<Button variant="outline">Rename chat</Button>
						</DialogTrigger>
						<DialogContent className="sm:max-w-lg">
							<DialogHeader>
								<DialogTitle>Rename chat</DialogTitle>
								<DialogDescription>The name appears in the sidebar and in search.</DialogDescription>
							</DialogHeader>
							<Field label="Name">{(props) => <Input {...props} defaultValue="Variance walkthrough" />}</Field>
							<DialogFooter>
								<DialogClose asChild>
									<Button variant="ghost">Cancel</Button>
								</DialogClose>
								<DialogClose asChild>
									<Button onClick={() => toast.success('Chat renamed')}>Rename chat</Button>
								</DialogClose>
							</DialogFooter>
						</DialogContent>
					</Dialog>

					<AlertDialog>
						<AlertDialogTrigger asChild>
							<Button variant="destructive">
								<Trash2Icon aria-hidden />
								Delete collection
							</Button>
						</AlertDialogTrigger>
						<AlertDialogContent>
							<AlertDialogHeader>
								<AlertDialogTitle>Delete “Course notes”?</AlertDialogTitle>
								<AlertDialogDescription>
									Its 3 files are removed from this app and from every model that searches them. This cannot be undone.
								</AlertDialogDescription>
							</AlertDialogHeader>
							<AlertDialogFooter>
								<AlertDialogCancel autoFocus>Cancel</AlertDialogCancel>
								<AlertDialogAction variant="destructive" onClick={() => toast.success('Collection deleted')}>
									Delete collection
								</AlertDialogAction>
							</AlertDialogFooter>
						</AlertDialogContent>
					</AlertDialog>

					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button variant="outline" size="icon" aria-label="More actions for this chat">
								<EllipsisIcon aria-hidden />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="start">
							<DropdownMenuItem>
								<PencilIcon aria-hidden />
								Rename
							</DropdownMenuItem>
							<DropdownMenuItem>
								<CopyIcon aria-hidden />
								Duplicate
							</DropdownMenuItem>
							<DropdownMenuSeparator />
							<DropdownMenuItem variant="destructive">
								<Trash2Icon aria-hidden />
								Delete
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			</Example>
		</Section>
	);
}

export function StatesSection() {
	const [state, setState] = useState<'loading' | 'empty' | 'searched' | 'filtered' | 'error'>('empty');
	return (
		<Section
			id="states"
			title="Loading, empty and failed"
			lead="Anything that shows data is designed four times: loading, empty, failed and full. An empty screen says what belongs there and offers the first step. A failure is never shown as an empty list or a zero."
			rules={['STA-1', 'STA-2', 'STA-3', 'STA-4', 'NAV-3']}
		>
			<Example title="One list, four states">
				<fieldset className="mb-3 flex flex-wrap gap-2">
					<legend className="sr-only">State to show</legend>
					{(
						[
							['loading', 'Loading'],
							['empty', 'Empty'],
							['searched', 'No results'],
							['filtered', 'Filtered out'],
							['error', 'Failed']
						] as const
					).map(([value, label]) => (
						<Button
							key={value}
							size="sm"
							variant={state === value ? 'secondary' : 'outline'}
							aria-pressed={state === value}
							onClick={() => setState(value)}
						>
							{label}
						</Button>
					))}
				</fieldset>
				<Panel className="flex min-h-56 max-w-[40rem] flex-col justify-center">
					{state === 'loading' && (
						<div aria-busy="true" className="flex flex-col gap-3">
							<p className="sr-only" role="status">
								Loading prompts
							</p>
							{[72, 56, 64].map((width) => (
								<div key={width} className="flex items-center gap-3">
									<div className="bg-surface-3 size-8 animate-pulse rounded-lg" />
									<div className="bg-surface-3 h-3 animate-pulse rounded" style={{ width: `${width}%` }} />
								</div>
							))}
						</div>
					)}
					{state !== 'loading' && state !== 'error' && (
						<ListEmptyState
							title="No prompts yet"
							description="A prompt is text you reuse. Save one and type / in a chat to insert it."
							action={
								<Button>
									<PlusIcon aria-hidden />
									New prompt
								</Button>
							}
							query={state === 'searched' ? 'regresion' : ''}
							filtered={state === 'filtered'}
							onClear={() => setState('empty')}
						/>
					)}
					{state === 'error' && <LoadFailed what="prompts" error={new ServerUnreachableError()} onRetry={() => {}} />}
				</Panel>
			</Example>
			<Example
				title="A row that failed"
				note="A failed upload stays in the list where it was: what failed, why in plain words, the server's text behind Details, and Retry and Dismiss. Dismiss alone when trying again cannot help. At 390 px the buttons wrap under the reason."
			>
				<Panel className="max-w-[40rem]">
					<FailedRowDemo />
				</Panel>
			</Example>
			<Example
				title="Something that no longer exists"
				note="A link to a deleted chat says so in place, keeps its address, and offers ways onward. It is for a definite answer that nothing is there; a failure to load offers to try again instead."
			>
				<Panel className="max-w-[40rem]">
					<Gone
						level={4}
						title="This chat no longer exists."
						description="It may have been deleted or archived, or the link may be mistyped."
						actions={
							<>
								<Button onClick={() => toast.success('New chat')}>
									<SquarePenIcon aria-hidden />
									New chat
								</Button>
								<Button variant="outline" onClick={() => toast.success('Search chats')}>
									<SearchIcon aria-hidden />
									Search chats
								</Button>
							</>
						}
					/>
				</Panel>
			</Example>
		</Section>
	);
}

const FENCE = '```';

/** An invented answer with everything that used to overflow (#946, #1082, #1086, #940). */
const ANSWER_SAMPLE = String.raw`Ridge regression shrinks the coefficients towards zero, which trades a little bias for a lot less variance. Ten-fold cross-validation on the invented data set:

| Model | λ | Train RMSE | Test RMSE | R² | Coefficients | Non-zero | Fit time, ms | Notes |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| Least squares | 0 | 1.92 | 2.41 | 0.71 | 12 | 12 | 3 | Follows the noise |
| Ridge | 0.1 | 1.95 | 2.30 | 0.74 | 12 | 12 | 4 | |
| Ridge | 1 | 2.01 | 2.18 | 0.77 | 12 | 12 | 4 | Lowest test error |
| Ridge | 10 | 2.24 | 2.29 | 0.74 | 12 | 12 | 4 | Over-shrunk |
| Lasso | 0.05 | 2.03 | 2.21 | 0.76 | 12 | 7 | 9 | Drops five features |

$$\hat{\beta}_{\text{ridge}} = \operatorname*{arg\,min}_{\beta} \left\{ \sum_{i=1}^{n} \left( y_i - \beta_0 - \sum_{j=1}^{p} x_{ij} \beta_j \right)^2 + \lambda \sum_{j=1}^{p} \beta_j^2 \right\} = \left( X^\top X + \lambda I_p \right)^{-1} X^\top y$$

- [x] Standardise the features first
- [x] Choose λ by cross-validation
- [ ] Plot the residuals against the fitted values

${FENCE}python
import numpy as np


def standardise(x: np.ndarray) -> np.ndarray:
    """Centre each column and scale it to unit variance."""
    return (x - x.mean(axis=0)) / x.std(axis=0, ddof=1)


def ridge(x: np.ndarray, y: np.ndarray, lam: float) -> np.ndarray:
    """The ridge coefficients for one penalty, intercept first."""
    n, p = x.shape
    design = np.column_stack([np.ones(n), x])
    penalty = lam * np.eye(p + 1)
    penalty[0, 0] = 0.0  # the intercept is not shrunk
    return np.linalg.solve(design.T @ design + penalty, design.T @ y)


def rmse(x: np.ndarray, y: np.ndarray, beta: np.ndarray) -> float:
    fitted = beta[0] + x @ beta[1:]
    return float(np.sqrt(np.mean((y - fitted) ** 2)))


def cross_validate(x: np.ndarray, y: np.ndarray, lams: list[float], k: int = 10) -> dict[float, float]:
    """Mean test RMSE over k folds for each penalty."""
    rng = np.random.default_rng(7)
    folds = np.array_split(rng.permutation(len(y)), k)
    scores: dict[float, float] = {}
    for lam in lams:
        errors = []
        for fold in folds:
            train = np.setdiff1d(np.arange(len(y)), fold)
            beta = ridge(x[train], y[train], lam)
            errors.append(rmse(x[fold], y[fold], beta))
        scores[lam] = float(np.mean(errors))
    return scores


x = standardise(np.loadtxt("features.csv", delimiter=",", skiprows=1))
y = np.loadtxt("target.csv", delimiter=",", skiprows=1)
print(cross_validate(x, y, [0.0, 0.1, 1.0, 10.0]))
${FENCE}`;

const reply = (id: string, content: string, extra: Partial<Message> = {}): Message => ({
	id,
	parentId: null,
	childrenIds: [],
	role: 'assistant',
	content,
	done: true,
	modelName: 'Coder',
	...extra
});
const STOPPED_REPLY = reply('ui-stopped', 'The standard error falls with the square root of the sample size, so', {
	stopped: true
});
const LENGTH_REPLY = reply(
	'ui-length',
	'Step one: centre each column. Step two: scale it to unit variance. Step three:',
	{
		finish_reason: 'length'
	}
);
const FAILED_REPLY = reply('ui-failed', '', {
	error: { content: 'Error code: 401 - {"error": {"message": "No auth credentials found"}}' }
});
const historyOf = (m: Message): History => ({ currentId: m.id, messages: { [m.id]: m } });
const said = (what: string) => () => toast.success(what);
const DEMO_HANDLERS = {
	onBranch: () => {},
	onRegenerate: said('Regenerating'),
	onFollowUp: () => {},
	onRetry: said('Regenerating'),
	onContinue: said('Continuing')
};

export function ContentSection() {
	return (
		<Section
			id="content"
			title="Answers: prose, mathematics and code"
			lead="What a model writes is the reason the app exists, so it gets the reading size, a measured line and one treatment wherever it appears: chat, notes, the playground, reports. Code takes its colours from the same tokens in both themes."
			rules={['CNT-1', 'CNT-2', 'CNT-3', 'CNT-5', 'TYP-5', 'DAT-6', 'FBK-1', 'FBK-3', 'FBK-4']}
		>
			<Example
				title="A rendered answer: a wide table, a long equation, a task list and a long code block"
				note="The chat's own renderer. The table and the equation scroll inside their frames and shade the edge that hides the rest; a code block over 25 lines can be collapsed, and Wrap lines is one setting for every block."
			>
				<div className="max-w-[72ch]">
					<Markdown id="ui-answer" content={ANSWER_SAMPLE} />
				</div>
			</Example>
			<Example
				title="A reply that failed, and replies that were cut off"
				note="A failure says what happened in the provider's own words, what to do for a cause it recognises, and offers Retry and Try another model. A reply that was stopped, or that reached the token limit, says so where it ends, with labelled Continue and Regenerate."
			>
				<div className="flex max-w-[72ch] flex-col gap-6">
					<ErrorReply
						message={FAILED_REPLY}
						onRetry={said('Retrying')}
						onTryAnotherModel={said('Opened the model picker')}
					/>
					{[STOPPED_REPLY, LENGTH_REPLY].map((m) => (
						<ResponseMessage key={m.id} history={historyOf(m)} message={m} h={DEMO_HANDLERS} isLast chatId={null} />
					))}
				</div>
			</Example>
			<Example
				title="A reply's steps"
				note="Each step is one line that says what it did; steps in a row collapse to the one the chain is at. The orb below the reply is its spinner while it is written."
			>
				<div className="max-w-[72ch]">
					<ReplySteps id="ui-steps" output={SAMPLE_STEPS} done={false} />
					<ReplyOrb output={SAMPLE_STEPS} />
				</div>
			</Example>
			<Example
				title="The code editor is a field"
				note="A label that names the content, the field's edge and fill, and a help line saying how to leave it. Press Check the code: Black cannot parse the last line, so its line is marked, its number turns red, and the help line says where, with Black's words behind Details. The editors do this before saving, so code that isn't valid Python is not sent."
			>
				<Panel>
					<CodeEditorFieldDemo />
				</Panel>
			</Example>
		</Section>
	);
}

/** An invented reply part-way through: a thought, two commands (one failed), a file written, one running. */
const SAMPLE_STEPS = [
	{
		type: 'reasoning',
		id: 's1',
		status: 'completed',
		duration: 4,
		content: [{ type: 'output_text', text: 'Count the rows first.' }]
	},
	{
		type: 'message',
		id: 's2',
		role: 'assistant',
		content: [{ type: 'output_text', text: 'I will check the data first.' }]
	},
	{
		type: 'function_call',
		id: 's3',
		call_id: 's3',
		name: 'bash',
		arguments: JSON.stringify({ command: 'wc -l data/trials.csv' }),
		status: 'completed'
	},
	{
		type: 'function_call_output',
		call_id: 's3',
		output: [
			{ type: 'input_text', text: JSON.stringify({ returncode: 0, stdout: '1201 data/trials.csv\n', stderr: '' }) }
		]
	},
	{
		type: 'function_call',
		id: 's4',
		call_id: 's4',
		name: 'bash',
		arguments: JSON.stringify({ command: 'python3 regress.py --model logit' }),
		status: 'completed'
	},
	{
		type: 'function_call_output',
		call_id: 's4',
		output: [
			{
				type: 'input_text',
				text: JSON.stringify({
					returncode: 1,
					stdout: '',
					stderr: "ModuleNotFoundError: No module named 'statsmodel'\n"
				})
			}
		]
	},
	{
		type: 'function_call',
		id: 's5',
		call_id: 's5',
		name: 'write_file',
		arguments: JSON.stringify({ path: '/workspace/regress.py', content: 'import statsmodels.api as sm\n' }),
		status: 'completed'
	},
	{
		type: 'function_call_output',
		call_id: 's5',
		output: [{ type: 'input_text', text: JSON.stringify({ path: '/workspace/regress.py', bytes_written: 29 }) }]
	},
	{
		type: 'function_call',
		id: 's6',
		call_id: 's6',
		name: 'bash',
		arguments: JSON.stringify({ command: 'python3 regress.py --model logit' }),
		status: 'in_progress'
	}
];
