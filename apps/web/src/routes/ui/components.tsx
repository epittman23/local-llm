import {
	CircleAlertIcon,
	CircleCheckIcon,
	CopyIcon,
	EllipsisIcon,
	Loader2Icon,
	PencilIcon,
	PlusIcon,
	RotateCwIcon,
	SearchXIcon,
	Trash2Icon,
	TriangleAlertIcon
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Katex } from '@/components/chat/markdown/Katex';
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
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { highlight } from './CodeSurface';
import { Example, Field, PageHeader, Panel, Section } from './parts';

// The second half of /ui: the shared components (components/ui) under the
// standard, and the patterns built from them. Every name and figure is
// invented (demo-a, example00a1, round numbers) so nothing here reads as a
// measurement; the kinds of thing are the ones this app holds.

type Status = 'success' | 'warning' | 'danger' | 'neutral';

const STATUS_STYLE: Record<Status, { icon: typeof CircleCheckIcon | null; className: string }> = {
	success: { icon: CircleCheckIcon, className: 'text-success border-success/40' },
	warning: { icon: TriangleAlertIcon, className: 'text-warning border-warning/40' },
	danger: { icon: CircleAlertIcon, className: 'text-danger border-danger/40' },
	neutral: { icon: null, className: 'text-foreground-muted border-border-control' }
};

/** COL-3, DAT-3: a status is a word with an icon, in its status colour. Never the colour alone. */
export function StatusBadge({ status, children }: { status: Status; children: string }) {
	const { icon: Icon, className } = STATUS_STYLE[status];
	return (
		<span
			className={`text-caption inline-flex h-5 items-center gap-1 rounded-full border px-2 font-strong ${className}`}
		>
			{Icon && <Icon aria-hidden className="size-3" />}
			{children}
		</span>
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
				note="A whole row that opens something is a row button, not a stretched button: it takes the full width, highlights on hover and marks the open row. A picture you press to change it is an image button: the picture fills it, and an icon appears over it on hover and on focus."
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
								<span
									aria-hidden
									className="bg-surface-3 text-foreground-muted font-strong flex size-8 shrink-0 items-center justify-center rounded-lg"
								>
									{row.name.slice(-1).toUpperCase()}
								</span>
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
						<span aria-hidden className="bg-surface-3 text-title font-title flex size-full items-center justify-center">
							A
						</span>
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
	const contextField = useRef<HTMLInputElement>(null);
	const dirty = name !== saved.name || context !== saved.context;
	const contextValid = /^\d+$/.test(context) && Number(context) >= 512 && Number(context) <= 32768;
	const contextError =
		contextChecked && !contextValid ? 'Enter a whole number of tokens between 512 and 32768.' : undefined;
	// FRM-3: leaving the page with unsaved changes asks first.
	useEffect(() => {
		if (!dirty) return;
		const ask = (event: BeforeUnloadEvent) => event.preventDefault();
		window.addEventListener('beforeunload', ask);
		return () => window.removeEventListener('beforeunload', ask);
	}, [dirty]);
	return (
		<Section
			id="forms"
			title="Forms"
			lead="Every field has a visible edge, a label that stays put, and its help or its error directly underneath. A form either saves when you press Save and tells you while changes are pending, or applies each change at once and says so. Never both without saying."
			rules={['FRM-1', 'FRM-2', 'FRM-3', 'FRM-4', 'FRM-5', 'FRM-6', 'COL-6']}
		>
			<Example
				title="A form that saves on request"
				note="Change a value: the bar at the bottom reports unsaved changes and offers to discard them, and reloading asks first. Type 40000 as the context size and leave the field: the error appears in place, in words that say how to fix it."
			>
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
						<div className="border-border -mx-4 -mb-4 flex flex-wrap items-center justify-between gap-3 rounded-b-xl border-t px-4 py-3">
							<p className="text-dense text-foreground-muted" role="status">
								{dirty ? 'Unsaved changes' : 'All changes saved'}
							</p>
							<div className="flex gap-2">
								<Button
									type="button"
									variant="ghost"
									disabled={!dirty}
									onClick={() => {
										setName(saved.name);
										setContext(saved.context);
										setContextChecked(false);
									}}
								>
									Discard changes
								</Button>
								<Button type="submit" disabled={!dirty}>
									Save profile
								</Button>
							</div>
						</div>
					</form>
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
			rules={['DAT-1', 'DAT-2', 'DAT-3', 'DAT-4', 'DAT-6', 'TYP-6']}
		>
			<Example
				title="A results table"
				note="On a narrow screen the table scrolls inside its own frame; the page never scrolls sideways."
			>
				<div className="border-border overflow-x-auto rounded-panel border">
					<Table className="text-dense min-w-[38rem]">
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
				note="Four meanings, each a word with an icon. The neutral one is for states that are neither good nor bad."
			>
				<div className="flex flex-wrap items-center gap-2">
					<StatusBadge status="success">Passed</StatusBadge>
					<StatusBadge status="warning">Throttled</StatusBadge>
					<StatusBadge status="danger">Failed</StatusBadge>
					<StatusBadge status="neutral">Not run</StatusBadge>
				</div>
			</Example>
		</Section>
	);
}

export function NavigationSection() {
	return (
		<Section
			id="navigation"
			title="Pages and navigation"
			lead="Every page opens the same way: its name, one sentence about what it is for, and its main action on the right. Sibling views are tabs, and the open tab is unmistakable."
			rules={['LAY-5', 'NAV-2']}
		>
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
		</Section>
	);
}

export function FeedbackSection() {
	return (
		<Section
			id="feedback"
			title="Feedback and overlays"
			lead="A message appears where the thing it is about is. A toast only confirms something that already finished; an error stays until you have dealt with it and says what to do. Escape closes the top layer only, and focus returns to what opened it."
			rules={['FBK-1', 'FBK-2', 'FBK-4', 'ACT-3', 'OVL-1', 'OVL-2', 'OVL-3', 'NAV-4']}
		>
			<Example
				title="Toasts"
				note="Success leaves on its own after four seconds. A failure stays, says what went wrong, and offers the next step."
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
	const [state, setState] = useState<'loading' | 'empty' | 'filtered' | 'error'>('empty');
	return (
		<Section
			id="states"
			title="Loading, empty and failed"
			lead="Anything that shows data is designed four times: loading, empty, failed and full. An empty screen says what belongs there and offers the first step. A failure is never shown as an empty list or a zero."
			rules={['STA-1', 'STA-2', 'STA-3', 'STA-4']}
		>
			<Example title="One list, four states">
				<fieldset className="mb-3 flex flex-wrap gap-2">
					<legend className="sr-only">State to show</legend>
					{(
						[
							['loading', 'Loading'],
							['empty', 'Empty'],
							['filtered', 'No results'],
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
					{state === 'empty' && (
						<div className="mx-auto max-w-sm text-center">
							<p className="text-title font-title">No prompts yet</p>
							<p className="text-foreground-muted mt-1">
								A prompt is text you reuse. Save one and type <code>/</code> in a chat to insert it.
							</p>
							<Button className="mt-4">
								<PlusIcon aria-hidden />
								New prompt
							</Button>
						</div>
					)}
					{state === 'filtered' && (
						<div className="mx-auto max-w-sm text-center">
							<SearchXIcon aria-hidden className="text-foreground-muted mx-auto size-5" />
							<p className="text-title mt-2 font-title">No prompts match “regresion”</p>
							<p className="text-foreground-muted mt-1">Check the spelling, or clear the search to see all 12.</p>
							<Button variant="outline" className="mt-4">
								Clear search
							</Button>
						</div>
					)}
					{state === 'error' && (
						<div className="mx-auto max-w-sm text-center" role="alert">
							<CircleAlertIcon aria-hidden className="text-danger mx-auto size-5" />
							<p className="text-title mt-2 font-title">Prompts could not be loaded</p>
							<p className="text-foreground-muted mt-1">
								The server did not answer. Your prompts are safe; this is a connection problem.
							</p>
							<Button variant="outline" className="mt-4">
								<RotateCwIcon aria-hidden />
								Try again
							</Button>
						</div>
					)}
				</Panel>
			</Example>
		</Section>
	);
}

const SAMPLE_CODE = `def summarize(x: np.ndarray) -> dict[str, float]:
    """Mean, unbiased variance and standard error of x."""
    n = len(x)
    return {"mean": x.mean(), "var": x.var(ddof=1), "se": x.std(ddof=1) / np.sqrt(n)}`;

export function ContentSection() {
	const [wrap, setWrap] = useState(false);
	return (
		<Section
			id="content"
			title="Answers: prose, mathematics and code"
			lead="What a model writes is the reason the app exists, so it gets the reading size, a measured line and one treatment wherever it appears: chat, notes, the playground, reports. Code takes its colours from the same tokens in both themes."
			rules={['CNT-1', 'CNT-2', 'CNT-3', 'TYP-5']}
		>
			<Example title="A rendered answer">
				<div className="text-reading flex max-w-[72ch] flex-col gap-4">
					<p>
						For observations <Katex content="x_1, \dots, x_n" displayMode={false} /> the unbiased estimator of the
						variance divides by <Katex content="n-1" displayMode={false} />:
					</p>
					<div className="border-border overflow-x-auto rounded-panel border px-4 py-2">
						<Katex content="s^2 = \frac{1}{n-1}\sum_{i=1}^{n}(x_i - \bar{x})^2" displayMode />
					</div>
					<figure className="border-border bg-surface-1 overflow-hidden rounded-panel border">
						<figcaption className="border-border text-dense text-foreground-muted flex items-center justify-between border-b px-3 py-1.5">
							<span>Python</span>
							<span className="flex gap-1">
								<Button variant="ghost" size="sm" aria-pressed={wrap} onClick={() => setWrap(!wrap)}>
									Wrap lines
								</Button>
								<Button variant="ghost" size="sm" onClick={() => toast.success('Code copied')}>
									<CopyIcon aria-hidden />
									Copy code
								</Button>
							</span>
						</figcaption>
						<pre
							className={`text-dense p-3 leading-relaxed ${wrap ? 'break-words whitespace-pre-wrap' : 'overflow-x-auto'}`}
						>
							<code>{highlight(SAMPLE_CODE, 'python')}</code>
						</pre>
					</figure>
				</div>
			</Example>
		</Section>
	);
}
