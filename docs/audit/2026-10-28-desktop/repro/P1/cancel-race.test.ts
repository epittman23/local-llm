// F4: Cancel while the /ready probe that will return 200 is in flight.
// startup() never re-checks the abort after the probe, so openApp() runs
// during the stop, sets phase = 'running', and the next close or quit calls
// shutdown() again, which sends a second SIGINT to the group.
import { EventEmitter } from 'node:events';

const h = await vi.hoisted(async () => {
	const m = await import('./main-harness.ts');
	let release!: (v: number) => void;
	const held = new Promise<number>((r) => (release = r));
	return { ...m.makeElectron(), tick: m.tick, held, release: (v: number) => release(v), readyCalls: 0 };
}, 10_000);

vi.mock('../../../../../apps/desktop/node_modules/electron/index.js', () => ({ ...h.electron, default: h.electron }));
vi.mock('../../../../../apps/desktop/src/config', async (orig) => ({
	...(await orig()),
	isRepoRoot: () => true
}));
vi.mock('../../../../../apps/desktop/src/stack', async (orig) => ({
	...(await orig()),
	isUiStale: async () => false,
	readProcStat: () => ({ comm: 'make', startTicks: '1' }),
	// health and dev server: nothing; the first /ready probe is the one in flight.
	probe: async (url: string) => {
		if (!url.endsWith('/ready')) return null;
		h.readyCalls++;
		return h.held;
	},
	spawnInGroup: () => Object.assign(new EventEmitter(), { pid: 990201 })
}));

const signals: string[] = [];
let groupGone = false;

test('a Cancel during the last /ready probe ends with two SIGINTs to the group', async () => {
	vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig: string | number) => {
		if (sig !== 0) signals.push(`${sig}:${pid}`);
		if (groupGone) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
		return true; // the group is still shutting down
	}) as never);
	await import('../../../../../apps/desktop/src/main');
	h.start();
	await h.tick(50);
	expect(h.readyCalls).toBe(1); // waitReady is awaiting this probe

	void h.statusCall('status:action', 'cancel'); // shutdown(): phase 'stopping', SIGINT
	await h.tick(20);
	console.log('after Cancel:', JSON.stringify(signals));
	h.release(200); // the in-flight probe answers 200
	await h.tick(20);
	const late = h.FakeWindow.getAllWindows().find((w) => w.loaded.startsWith('http'));
	console.log('app window created after the cancel:', Boolean(late), late?.loaded);
	expect(late).toBeDefined();
	late!.emit('ready-to-show'); // phase = 'running', shutdown dialog destroyed
	await h.tick(20);
	console.log('status dialog still open:', h.FakeWindow.getAllWindows().some((w) => w.loaded.endsWith('status.html')));
	late!.userClose(); // the user closes the window that just appeared
	await h.tick(300);
	console.log('signals sent:', JSON.stringify(signals));
	groupGone = true;
	await h.tick(1500);
	expect(signals.filter((s) => s.startsWith('SIGINT'))).toHaveLength(2);
}, 10_000);
