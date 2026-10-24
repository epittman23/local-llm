// Renders the progress snapshots main.ts sends (src/progress.ts's Progress)
// and the settings form. Talks to main only through window.lllmStatus
// (src/status-preload.ts).

const $ = (id) => document.getElementById(id);
const api = window.lllmStatus;

let progress = null;
let followLog = true;

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
	if (progress.error) {
		actions.append(button('Settings', 'settings'));
		if (hasLog) actions.append(button('Open log', 'open-log'));
		actions.append(button('Quit', 'quit'), button('Retry', 'retry', true));
	} else if (progress.offerStopLlama) {
		actions.append(
			button('Open log', 'open-log'),
			button('Leave it', 'quit'),
			button('Stop llama-server', 'stop-llama', true)
		);
	} else if (progress.kind === 'startup' && !progress.finished) {
		actions.append(button('Cancel', 'cancel'));
	}
}

function renderSteps(now) {
	const list = $('steps');
	list.replaceChildren();
	for (const step of progress.steps) {
		if (step.optional && (step.state === 'pending' || step.state === 'skipped')) continue;
		const li = document.createElement('li');
		li.className = step.state;
		const icon = document.createElement('span');
		icon.className = 'icon';
		icon.setAttribute('aria-label', step.state);
		const label = document.createElement('span');
		label.className = 'label';
		label.textContent = step.label;
		const time = document.createElement('span');
		time.className = 'time';
		time.textContent = stepTime(step, now);
		li.append(icon, label, time);
		if (step.detail) {
			const sub = document.createElement('span');
			sub.className = 'sub';
			sub.textContent = step.detail;
			sub.title = step.detail;
			li.append(sub);
		}
		if (step.state === 'running' && step.hint && now - step.startedAt >= step.hint.afterMs) {
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
	$('error').textContent = progress.error ?? '';
	$('details').hidden = progress.log.length === 0;
	const log = $('log');
	const text = progress.log.join('\n');
	if (log.textContent !== text) {
		log.textContent = text;
		if (followLog) log.scrollTop = log.scrollHeight;
	}
}

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
	$('settings-message').textContent = '';
	$('restart').hidden = true;
}

function showView(view) {
	$('progress-view').hidden = view !== 'progress';
	$('settings-view').hidden = view !== 'settings';
	if (view === 'settings') void loadSettings();
}

$('settings-form').addEventListener('submit', async (event) => {
	event.preventDefault();
	const message = $('settings-message');
	const result = await api.saveSettings({ serverUrl: $('server-url').value, repoPath: $('repo-path').value });
	message.classList.toggle('error-text', Boolean(result.error));
	if (result.error) {
		message.textContent = result.error;
	} else if (result.restart || settingsRunning) {
		message.textContent = 'Saved. It applies the next time Local LLM starts.';
		$('restart').hidden = false;
	} else {
		message.textContent = 'Saved. Retry to start with it.';
	}
});

$('browse').addEventListener('click', async () => {
	const folder = await api.browseRepo();
	if (folder) $('repo-path').value = folder;
});

$('restart').addEventListener('click', () => void api.action('restart'));

$('settings-back').addEventListener('click', () => {
	void api.action('close-settings');
	if (progress?.steps.length) showView('progress');
});

$('log').addEventListener('scroll', () => {
	const log = $('log');
	followLog = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
});

api.onUpdate(onProgress);
api.onView(showView);
void api.ready().then(({ progress: initial, view }) => {
	if (initial) onProgress(initial);
	showView(view);
});
setInterval(render, 250);
