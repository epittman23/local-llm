// F1: after a forced stop that leaves a llama-server, "Leave it" (action
// 'quit') does nothing and the dialog cannot be closed.
import { EventEmitter } from 'node:events';

const h = await vi.hoisted(async () => {
	const m = await import('./main-harness.ts');
	return { ...m.makeElectron(), tick: m.tick };
});
const signals: string[] = [];

vi.mock('../../../../../apps/desktop/node_modules/electron/index.js', () => ({ ...h.electron, default: h.electron }));
vi.mock('../../../../../apps/desktop/src/config', async (orig) => ({
	...(await orig()),
	isRepoRoot: () => true
}));
vi.mock('../../../../../apps/desktop/src/stack', async (orig) => ({
	...(await orig()),
	isUiStale: async () => false,
	readProcStat: () => ({ comm: 'make', startTicks: '1' }),
	probe: async (url: string) => (url.endsWith('/ready') ? 200 : null),
	spawnInGroup: () => Object.assign(new EventEmitter(), { pid: 990001 }),
	stopGroup: async () => ({ forced: true, llama: [777] }),
	llamaServerPids: async () => [777]
}));

test('Leave it is a no-op and the dialog refuses to close', async () => {
	vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig: string) => {
		signals.push(`${sig}:${pid}`);
		return true;
	}) as never);
	await import('../../../../../apps/desktop/src/main');
	h.start();
	await h.tick(50);
	const main = h.windows.find((w) => typeof w.loaded === 'string' && w.loaded.startsWith('http'));
	expect(main).toBeDefined();
	main!.emit('ready-to-show'); // the page painted: phase = 'running'
	await h.tick(10);
	expect(main!.userClose()).toBe(false); // owned + running: close becomes shutdown()
	await h.tick(50);
	console.log('after forced stop, exits =', JSON.stringify(h.exits));
	expect(h.exits).toEqual([]); // offer shown, waiting for the user

	await h.statusCall('status:action', 'quit'); // "Leave it"
	await h.tick(800);
	console.log('after Leave it, exits =', JSON.stringify(h.exits));
	const status = h.FakeWindow.getAllWindows().at(-1)!;
	const closed = status.userClose();
	console.log('closing the dialog allowed =', closed, '; exits =', JSON.stringify(h.exits));
	expect(h.exits).toEqual([]);
	expect(closed).toBe(false);
	// before-quit (Ctrl+Q / logout) is not prevented by main.ts any more (owned is null)...
	let prevented = false;
	h.appEvents.emit('before-quit', { preventDefault: () => (prevented = true) });
	console.log('before-quit prevented by main.ts =', prevented);
});
