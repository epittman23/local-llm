import { useState } from 'react';
import { toast } from 'sonner';
import type { TestResult } from '@/components/settings/connectionModel';
import { ConnectionUrlField, Disclosure, FormField } from '@/components/settings/formFields';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
	Dialog,
	DialogBody,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StatusNotice } from '@/components/ui/status-notice';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableSortHead } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { CHART_COLORS } from '@/routes/admin/analytics/analytics';
import { ChartLine } from '@/routes/admin/analytics/ChartLine';

// Admin's patterns on /ui: a section's state, the folded settings group, a
// URL field with Test connection, a table whose rows open and whose headings
// sort, a tall dialog and a chart. Every name and number is invented.

/** STA-4, COL-3: a section's state, in its four tones. */
export function StatusNoticeDemo() {
	return (
		<div className="flex max-w-[40rem] flex-col gap-3">
			<StatusNotice tone="success" title="The sandbox is ready">
				<p>Code runs in its own virtual machine.</p>
			</StatusNotice>
			<StatusNotice tone="pending" title="Checking the sandbox…" />
			<StatusNotice
				tone="warning"
				title="The sandbox is not ready"
				action={
					<Button variant="outline" size="sm" onClick={() => toast.success('Checked again')}>
						Check again
					</Button>
				}
				details="kata-clh runtime not registered with Docker"
			>
				<p>Code can't run until the sandbox runtime is installed. The steps are in the sandbox guide.</p>
			</StatusNotice>
			<StatusNotice tone="danger" title="Couldn't check the sandbox" details="GET /api/v1/utils/sandbox: 502">
				<p>The server didn't answer. Try again in a moment.</p>
			</StatusNotice>
		</div>
	);
}

/** FRM-6: a folded settings group, closed and open. */
export function DisclosureDemo() {
	const [demoA, setDemoA] = useState(true);
	return (
		<div className="flex max-w-[40rem] flex-col gap-2">
			<Disclosure title="Sign-in with an identity provider" description="Not configured">
				<p className="text-foreground-muted text-dense">Set by environment variables.</p>
			</Disclosure>
			<Disclosure
				title="Default interface settings"
				description="What every account starts from. A personal setting overrides its default."
				meta={<Badge variant="secondary">1 changed</Badge>}
				defaultOpen
			>
				<div className="flex items-center gap-2.5">
					<Switch id="ui-demo-wide" checked={demoA} onCheckedChange={setDemoA} />
					<Label htmlFor="ui-demo-wide" className="text-body font-normal">
						Widescreen mode
					</Label>
				</div>
			</Disclosure>
		</div>
	);
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** FBK-1: a URL field with Test connection beside it, idle until tested; a reachable one and a failed one. */
export function ConnectionUrlDemo() {
	const [reachable, setReachable] = useState('http://127.0.0.1:8090/v1');
	const [failing, setFailing] = useState('http://127.0.0.1:9/v1');
	const [notUrl, setNotUrl] = useState('demo-a.local');
	// The form's own check runs on leaving the field, as a connection dialog's does.
	const [left, setLeft] = useState(false);
	return (
		<div className="flex max-w-[32rem] flex-col gap-5">
			<ConnectionUrlField
				id="ui-demo-url-ok"
				label="URL (reachable)"
				value={reachable}
				onChange={setReachable}
				help="Idle until tested. Press Test connection."
				onTest={async (): Promise<TestResult> => {
					await wait(400);
					return { ok: true, text: 'Reachable: 3 models' };
				}}
			/>
			<ConnectionUrlField
				id="ui-demo-url-dead"
				label="URL (nothing listening)"
				value={failing}
				onChange={setFailing}
				onTest={async (): Promise<TestResult> => {
					await wait(400);
					return { ok: false, text: 'Connection refused at 127.0.0.1:9.' };
				}}
			/>
			<ConnectionUrlField
				id="ui-demo-url-bad"
				label="URL (not a URL)"
				value={notUrl}
				onChange={setNotUrl}
				help="Leave the field to check it."
				error={left && !/^https?:\/\//.test(notUrl) ? 'Enter a URL that starts with http:// or https://.' : null}
				onBlur={() => setLeft(true)}
				onTest={async () => null}
			/>
		</div>
	);
}

const MODELS = [
	{ id: 'demo-a', name: 'Statistics tutor', won: 18, lost: 4 },
	{ id: 'demo-b', name: 'Code reviewer', won: 11, lost: 9 },
	{ id: 'demo-c', name: 'Draft explainer', won: 6, lost: 12 }
];

/** DAT-6, NAV-5: sortable headings, and rows that open from a click anywhere or from their name button. */
export function OpeningTableDemo() {
	const [sort, setSort] = useState<{ key: 'name' | 'won'; direction: 'asc' | 'desc' }>({
		key: 'won',
		direction: 'desc'
	});
	const toggle = (key: 'name' | 'won') =>
		setSort((s) => ({ key, direction: s.key === key && s.direction === 'desc' ? 'asc' : 'desc' }));
	const rows = [...MODELS].sort((a, b) => {
		const by = sort.key === 'name' ? a.name.localeCompare(b.name) : a.won - b.won;
		return sort.direction === 'asc' ? by : -by;
	});
	const openRow = (name: string) => toast.success(`Opened “${name}”`);
	return (
		<div className="max-w-[40rem]">
			<Table aria-label="Leaderboard">
				<TableHeader>
					<TableRow>
						<TableSortHead
							label="Model"
							active={sort.key === 'name'}
							direction={sort.direction}
							onSort={() => toggle('name')}
						/>
						<TableSortHead
							label="Won"
							className="text-right"
							active={sort.key === 'won'}
							direction={sort.direction}
							onSort={() => toggle('won')}
						/>
						<TableHead scope="col" className="text-right">
							Lost
						</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.map((row) => (
						<TableRow key={row.id} onOpen={() => openRow(row.name)}>
							<TableCell>
								<Button
									variant="ghost"
									size="sm"
									className="text-foreground -mx-2.5 max-w-full shrink justify-start"
									onClick={() => openRow(row.name)}
								>
									<span className="truncate">{row.name}</span>
								</Button>
							</TableCell>
							<TableCell className="text-right tabular-nums">{row.won}</TableCell>
							<TableCell className="text-right tabular-nums">{row.lost}</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	);
}

/** OVL-1: a dialog taller than the viewport keeps its header and buttons, and scrolls its fields in DialogBody. */
export function TallDialogDemo() {
	return (
		<Dialog>
			<DialogTrigger asChild>
				<Button variant="outline">Edit connection</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Edit connection</DialogTitle>
					<DialogDescription>A long form: its fields scroll, its title and buttons stay.</DialogDescription>
				</DialogHeader>
				<DialogBody>
					{['URL', 'Prefix ID', 'Provider', 'Model IDs', 'Tags', 'Passthrough parameters'].map((label) => (
						<FormField key={label} id={`ui-demo-tall-${label}`} label={label} optional={label !== 'URL'}>
							{(props) => <Input {...props} />}
						</FormField>
					))}
					<FormField id="ui-demo-tall-headers" label="Headers" optional help='A JSON object, such as {"X-Demo": "a"}.'>
						{(props) => <Textarea {...props} rows={6} />}
					</FormField>
				</DialogBody>
				<DialogFooter>
					<DialogClose asChild>
						<Button variant="ghost">Cancel</Button>
					</DialogClose>
					<DialogClose asChild>
						<Button onClick={() => toast.success('Connection saved')}>Save connection</Button>
					</DialogClose>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

const DAYS = ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15'];
const CHART = DAYS.map((date, i) => ({
	date,
	models: { 'demo-a': [4, 7, 5, 9, 12, 8, 10][i], 'demo-b': [2, 3, 6, 4, 5, 7, 3][i] }
}));
const CHART_NAMES: Record<string, string> = { 'demo-a': 'Statistics tutor', 'demo-b': 'Code reviewer' };

/** DAT-1, COL-8, A11Y-4: a chart with a legend, a titled y axis and Show as table. */
export function ChartDemo() {
	return (
		<div className="max-w-[48rem]">
			<ChartLine
				data={CHART}
				models={['demo-a', 'demo-b']}
				colors={CHART_COLORS}
				height={200}
				period="week"
				labelOf={(id) => CHART_NAMES[id] ?? id}
			/>
		</div>
	);
}
