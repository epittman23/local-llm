// Renders the progress snapshots main.ts sends (src/progress.ts's Progress)
// and the settings form. Talks to main only through window.lllmStatus
// (src/status-preload.ts).

const $ = (id) => document.getElementById(id);
const api = window.lllmStatus;

let progress = null;
let followLog = true;
/** Where render() last scrolled the log (to a pixel or two, on a scaled display), so its own scroll is not taken for the reader's. */
let autoScrollTop = -1;

function formatDuration(ms) {
	const seconds = Math.max(0, ms) / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)} s`;
	const whole = Math.floor(seconds);
	return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function stepTime(step, now) {
	if (step.startedAt === undefined || step.state === 'skipped') return '';
	return formatDuration((step.endedAt ?? now) - step.startedAt);
}

function button(label, action, primary = false) {
	const el = document.createElement('button');
	el.type = 'button';
	el.textContent = label;
	if (primary) el.className = 'primary';
	el.addEventListener('click', () => {
		if (action === 'settings') return showView('settings');
		void api.action(action);
	});
	return el;
}

function renderActions() {
	const actions = $('actions');
	actions.replaceChildren();
	if (!progress) return;
	// No log for a remote server: nothing was started here.
	const hasLog = progress.log.length > 0;
	if (progress.error && progress.kind === 'shutdown') {
		// A stop that went wrong: the log says why; there is nothing to retry.
		if (hasLog) actions.append(button('Open log', 'open-log'));
		actions.append(button('Quit', 'quit', true));
	} else if (progress.error) {
		actions.append(button('Settings', 'settings'));
		if (hasLog) actions.append(button('Open log', 'open-log'));
		actions.append(button('Quit', 'quit'), button('Retry', 'retry', true));
	} else if (progress.offerStopLlama) {
		actions.append(
			button('Open log', 'open-log'),
			button('Leave it running', 'quit'),
			button('Stop it', 'stop-llama', true)
		);
	} else if (progress.kind === 'startup' && !progress.finished) {
		actions.append(button('Cancel', 'cancel'));
	}
}

function stepItem(state, text) {
	const li = document.createElement('li');
	li.className = state;
	const icon = document.createElement('span');
	icon.className = 'icon';
	icon.setAttribute('aria-label', state);
	const label = document.createElement('span');
	label.className = 'label';
	label.textContent = text;
	li.append(icon, label);
	return li;
}

function renderSteps(now) {
	const list = $('steps');
	list.replaceChildren();
	// Once something needs an answer, the steps that went well fold into one
	// line, so the problem and its buttons fit the window (#926).
	const fold = Boolean(progress.error || progress.offerStopLlama);
	const done = progress.steps.filter((step) => step.state === 'done').length;
	if (fold && done > 0) list.append(stepItem('done', done === 1 ? '1 step done' : `${done} steps done`));
	for (const step of progress.steps) {
		if (step.optional && (step.state === 'pending' || step.state === 'skipped')) continue;
		if (fold && (step.state === 'done' || step.state === 'skipped')) continue;
		const li = stepItem(step.state, step.label);
		const time = document.createElement('span');
		time.className = 'time';
		time.textContent = stepTime(step, now);
		li.append(time);
		const hinted = step.state === 'running' && step.hint && now - step.startedAt >= step.hint.afterMs;
		// A hint, once it shows, says more than the raw output line it replaces.
		if (step.detail && !(hinted && step.detailIsOutput)) {
			const sub = document.createElement('span');
			sub.className = step.detailIsOutput ? 'sub output' : 'sub';
			sub.textContent = step.detail;
			sub.title = step.detail;
			li.append(sub);
		}
		if (hinted) {
			const hint = document.createElement('span');
			hint.className = 'hint';
			hint.textContent = step.hint.text;
			li.append(hint);
		}
		list.append(li);
	}
}

function render() {
	if (!progress) return;
	const now = Date.now();
	$('title').textContent = progress.title;
	document.title = progress.title;
	$('elapsed').textContent = formatDuration((progress.endedAt ?? now) - progress.startedAt);
	renderSteps(now);
	$('error').hidden = !progress.error;
	$('cause').hidden = !progress.cause;
	$('cause').textContent = progress.cause ?? '';
	$('error-message').textContent = progress.error ?? '';
	$('notice').hidden = !(progress.offerStopLlama && !progress.error);
	$('details').hidden = progress.log.length === 0;
	const log = $('log');
	const text = progress.log.join('\n');
	if (log.textContent !== text) log.textContent = text;
	// Every tick, not only on new text: the log's font arrives after its first
	// lines, and the longer wrap it gives would leave the end out of view.
	if (followLog) {
		log.scrollTop = log.scrollHeight;
		autoScrollTop = log.scrollTop;
	}
}

$('details').addEventListener('toggle', () => {
	$('details-toggle').textContent = $('details').open ? 'Hide log' : 'Show log';
});

function onProgress(next) {
	const failedNow = next.error && !progress?.error;
	progress = next;
	if (failedNow) $('details').open = true;
	renderActions();
	render();
}

// --- Settings ---------------------------------------------------------------------

let settingsRunning = false;

async function loadSettings() {
	const settings = await api.getSettings();
	$('server-url').value = settings.serverUrl;
	$('repo-path').value = settings.repoPath;
	settingsRunning = settings.running;
	// The address in use when --server-url or LLLM_SERVER_URL overrides the saved one (#424).
	$('server-override').hidden = !settings.override;
	$('server-override').textContent = settings.override
		? `This launch uses ${settings.override.url}, from ${settings.override.from}, in place of the saved address. Saving replaces it.`
		: '';
	$('server-problem').hidden = !settings.problem;
	$('server-problem').textContent = settings.problem ?? '';
	$('settings-message').textContent = '';
	$('restart').hidden = true;
}

/**
 * Settings opened from the app's menu, once the app is running, has no
 * progress to go back to: main.ts closes the window, so the button says Close.
 */
function hasProgressView() {
	return Boolean(progress?.steps.length) && !(progress.kind === 'startup' && progress.finished);
}

function showView(view) {
	$('progress-view').hidden = view !== 'progress';
	$('settings-view').hidden = view !== 'settings';
	$('settings-back').textContent = hasProgressView() ? 'Back' : 'Close';
	if (view === 'settings') void loadSettings();
}

$('settings-form').addEventListener('submit', async (event) => {
	event.preventDefault();
	const message = $('settings-message');
	let result;
	try {
		result = await api.saveSettings({ serverUrl: $('server-url').value, repoPath: $('repo-path').value });
	} catch (error) {
		// Never a silent failure (#426).
		result = { error: `Could not save the settings: ${error instanceof Error ? error.message : error}` };
	}
	message.classList.toggle('error-text', Boolean(result.error));
	if (result.error) {
		message.textContent = result.error;
		return;
	}
	$('server-override').hidden = true;
	$('server-problem').hidden = true;
	const instead = result.replaced ? `, in place of ${result.replaced.url} from ${result.replaced.from}` : '';
	if (result.restart || settingsRunning) {
		// A launch with the override again uses it again; Restart now leaves it out (#424).
		message.textContent = result.replaced
			? `Saved. Restart now starts with it, without ${result.replaced.url} from ${result.replaced.from}.`
			: 'Saved. It applies the next time local-llm starts.';
		$('restart').hidden = false;
	} else {
		message.textContent = `Saved. Retry to start with it${instead}.`;
	}
});

$('browse').addEventListener('click', async () => {
	const folder = await api.browseRepo();
	if (folder) $('repo-path').value = folder;
});

$('restart').addEventListener('click', () => void api.action('restart'));

$('settings-back').addEventListener('click', () => {
	void api.action('close-settings');
	if (hasProgressView()) showView('progress');
});

$('log').addEventListener('scroll', () => {
	const log = $('log');
	if (Math.abs(log.scrollTop - autoScrollTop) <= 2) return;
	followLog = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
});

api.onUpdate(onProgress);
api.onView(showView);
void api.ready().then(({ progress: initial, view }) => {
	if (initial) onProgress(initial);
	showView(view);
});
setInterval(render, 250);
