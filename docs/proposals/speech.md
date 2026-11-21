# Proposed Speech Improvements

> **PROPOSED ONLY. NOTHING IN THIS DOCUMENT IS BUILT.**

| Field   | Value                                                                                                        |
| ------- | ------------------------------------------------------------------------------------------------------------ |
| Written | 2026-11-21                                                                                                   |
| State   | Proposed, not started                                                                                        |
| Related | [proposed-inference-server.md](proposed-inference-server.md), [retrieval-evaluation.md](retrieval-evaluation.md) |

## Purpose

Three related proposals:

1. **Dictation**: bring back microphone input in the chat composer, which the React port
   left out.
2. **Speech models on the inference server**: better speech-to-text (STT) and
   text-to-speech (TTS) than the current local defaults, reached through the existing
   OpenAI-compatible engines.
3. **Tests**: tests for the dictation feature, and an evaluation for choosing speech
   models.

Priorities, from the owner: quality first, speed second; privacy as the project's first goal
rules out the cloud engines as defaults.

## Current state

Summarised from the code on 2026-11-21. Which engine is selected is a database setting
(Admin > Settings > Audio), not visible from the repository; this describes the defaults.

| Direction | Where it is used                                         | Default engine                                                 | Code                                         |
| --------- | -------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------- |
| STT       | Audio files uploaded to a chat or knowledge base only    | faster-whisper `base`, `int8`, CPU, beam 5, VAD off            | `routers/audio.py` (`transcribe`), `routers/files.py` |
| TTS       | "Read aloud" on a message, sentence by sentence          | the browser's `speechSynthesis` voices; no server involvement  | `apps/web/src/routes/chat/useReadAloud.ts`   |

Already in place and unused by the interface: `POST /audio/transcriptions` (multipart `file`,
optional `language`, `chat.stt` permission) and the frontend's `transcribeAudio()` in
`apps/web/src/lib/apis/audio/index.ts`. Files over 20 MB are split before transcription.
Server TTS responses are cached by a hash of text, engine and model in `SPEECH_CACHE_DIR`.

Not ported from the Svelte app (`docs/decisions.md`, Phase 9 and 10 entries): voice input,
call mode, the in-browser Kokoro TTS engine.

## Part 1: Dictation in the composer

### Behaviour

- A microphone button in `ChatInput.tsx`. Press to record, press again (or Enter) to stop.
  Esc cancels and discards.
- While recording: a visible recording state, elapsed time, and a level meter so the user
  can tell the microphone is live.
- On stop: the clip is sent to `POST /audio/transcriptions`; the transcript is **inserted
  into the composer at the cursor, not sent**, so it can be corrected first. Dictation
  errors in math and code are likely enough that auto-send would be a poor default.
- The button is hidden when the user lacks `chat.stt` or the browser has no
  `MediaRecorder`; it is disabled with an explanation when microphone permission is denied.
- With STT set to "browser's speech recognition" (`web`), use the browser's
  `SpeechRecognition` where available instead of uploading. Note that in Chromium this
  sends audio to Google's service, so the settings page should say so; it is not private.

### Implementation sketch

- A `useDictation` hook: `getUserMedia({ audio: true })` → `MediaRecorder` (Opus in WebM on
  Chromium and Firefox; the backend's pydub and ffmpeg step converts it) → `File` →
  `transcribeAudio()`.
- Stop all tracks on stop, cancel and unmount, so the browser's recording indicator goes off.
- A maximum recording length (proposed 5 minutes) to keep uploads below the 20 MB split
  threshold and latency predictable.
- Microphone access requires a secure context. `localhost` qualifies; a LAN address over
  plain HTTP (`LLLM_BACKEND_HOST=0.0.0.0`) does not, so dictation will not work there
  without HTTPS. The desktop app loads the server's pages and inherits the same rule.
- Follows the interface standard (`docs/guides/ui-standard.md`): dark first, keyboard
  operable, all four data states (idle, recording, transcribing, error).

## Part 2: Speech models on the inference server

### How they would connect

Both directions already have an "OpenAI-compatible API" engine, so moving to the server is
a settings change, matching the project rule that only URLs and keys change:

- STT: engine `openai`, base URL of a server exposing `/v1/audio/transcriptions`.
- TTS: engine `openai`, base URL of a server exposing `/v1/audio/speech`, with its model and
  voice names.

`llama-server` serves neither endpoint, so a separate speech server would run beside it.
Projects that expose these OpenAI-shaped endpoints for open models exist (for example
Speaches, formerly faster-whisper-server, and Kokoro-FastAPI). Their compatibility with this
app's request shapes is **unverified**; check it before relying on one.

### Candidate models

Point-in-time knowledge as of mid-2026; verify current versions, licences and leaderboards
before choosing.

| Direction | Candidate                       | Size     | Notes                                                                                 |
| --------- | ------------------------------- | -------- | ------------------------------------------------------------------------------------- |
| STT       | Whisper `base` (current)        | ~74 M    | Baseline. Fast, least accurate.                                                       |
| STT       | Whisper `large-v3-turbo`        | ~0.8 B   | Near `large-v3` accuracy at a fraction of decode cost; multilingual.                  |
| STT       | Whisper `large-v3`              | ~1.55 B  | Highest Whisper accuracy; slower.                                                     |
| STT       | NVIDIA Parakeet TDT 0.6B        | ~0.6 B   | Very fast and accurate on English; English-focused; NeMo toolchain.                   |
| TTS       | Browser voices / SpeechT5 (current) | n/a  | Baselines.                                                                            |
| TTS       | Kokoro-82M                      | 82 M     | Small, good quality, permissive licence; runs well even on CPU.                       |
| TTS       | Piper                           | small    | Very fast, CPU-friendly, lower naturalness.                                           |
| TTS       | Larger neural TTS (e.g. Orpheus, Chatterbox) | 0.5-3 B | More natural and expressive; check each licence; more VRAM and latency.  |

### Fit on the V100

The inference server proposal's chat model takes about 22 GB of 32 GB, and its retrieval
section estimates 7-8 GB for a reranker and embedding model. That leaves little or no room.
Estimates, unmeasured:

| Model                                 | Approx. VRAM |
| ------------------------------------- | ------------ |
| Whisper `large-v3-turbo`, FP16        | 2-3 GB       |
| Kokoro-82M                            | < 1 GB       |

Options, in order of preference:

1. **Kokoro on the CPU** (it is small enough), and **Whisper on the GPU only if the budget
   allows**, measured on the card.
2. **Whisper on the CPU** with `int8` (faster-whisper): `large-v3-turbo` is usable on the
   R730's 20 cores for short dictation clips, slower for long files. This avoids touching
   the VRAM budget entirely.
3. Trade against retrieval: a smaller reranker frees room for Whisper.

The tests in Part 3 decide between these.

## Part 3: Tests

### 3a. Tests for the dictation feature

These follow the repository's two kinds of testing (`docs/guides/testing.md`). All must pass
in `make check`.

**Vitest (`apps/web`)**, with `MediaRecorder` and `getUserMedia` stubbed:

| Test                                                         | Checks                                             |
| ------------------------------------------------------------ | -------------------------------------------------- |
| Button hidden without `chat.stt` permission                  | permission gating                                  |
| Button hidden when `MediaRecorder` is undefined              | feature detection                                  |
| Permission denied shows the disabled state and its message   | error state                                        |
| Start then stop calls `transcribeAudio` once with a `File`   | the recording-to-upload path                       |
| Transcript is inserted at the cursor, existing text kept     | insertion, not replacement                         |
| Transcript is never sent automatically                       | the no-auto-send rule                              |
| Esc cancels: no upload, tracks stopped                       | cancel path                                        |
| Unmount while recording stops all tracks                     | no microphone left open                            |
| Recording stops at the maximum length                        | length cap                                         |
| A failed transcription shows an error and keeps the composer text | error state                                   |

**Playwright (`apps/web`)**, backend mocked as the suite already does; Chromium's
`--use-fake-device-for-media-stream` and `--use-fake-ui-for-media-stream` flags supply a
fake microphone:

| Test                                                                   | Checks                                   |
| ---------------------------------------------------------------------- | ---------------------------------------- |
| Record, stop, mocked transcript appears in the composer                | end to end in the browser                |
| Keyboard only: focus the button, Enter to start and stop, Esc to cancel | keyboard operation (interface standard)  |
| Dark and light screenshots of idle, recording, transcribing and error  | the four states, both themes             |

If the fake-media flags need changes to the Playwright configuration, that file is a gate
under the PR gate; the change would be listed and justified under `## Gate changes` and
approved by the owner before merging.

**pytest (`apps/server`)**, extending the audio tests beside `tests/test_audio_config_save.py`:

| Test                                                                  | Checks                                         |
| --------------------------------------------------------------------- | ---------------------------------------------- |
| `POST /audio/transcriptions` refuses users without `chat.stt`         | permission                                     |
| A short WebM/Opus clip is accepted and converted before transcription | the browser's recording format works           |
| Engine `web` is refused for uploads with the #343 message              | existing behaviour kept                        |
| Engine `openai` sends the expected multipart request to a mock server | the path the inference server would use        |

**Real run.** Playwright mocks the backend, so the change crosses the frontend/backend seam
and also needs one real run: dictate a sentence in the browser against `make backend` with
local Whisper, and check the transcript appears.

### 3b. Evaluating STT models

**Test set.** 50-100 short clips, recorded by the owner on the microphones actually used
(laptop and any headset), each with a hand-checked reference transcript. Categories, since
general benchmarks under-represent this project's vocabulary:

| Category            | Example                                                      |
| ------------------- | ------------------------------------------------------------ |
| Everyday dictation  | "remind me what we decided about the reranker"               |
| Statistics terms    | "heteroscedasticity", "Mann-Whitney U", "p less than 0.05"   |
| Math spoken aloud   | "x squared plus two x minus one over three"                  |
| Code and identifiers | "call read underscore settings with strict equals true"     |
| Numbers and units   | "three point one four", "twenty twenty-six", "500 milliseconds" |
| Noisy conditions    | the same sentences with background noise or a fan running    |

Clips stay in `DATA_DIR`, out of git, as the owner's voice is personal data. A small public
seed set (openly licensed speech) can be committed for automated checks.

**Metrics.**

- **Word error rate (WER)**: (substitutions + deletions + insertions) / reference words,
  after normalising case and punctuation. Reported overall and per category.
- **Term error rate**: share of domain terms (from a list per clip) transcribed wrongly. A
  model can have a good WER and still mangle the terms that matter.
- **Latency**: time from end of recording to transcript, p50 and p95, for 5 s, 30 s and
  2 min clips; real-time factor for long files.
- **Resources**: peak VRAM or RAM; whether it fits the budget above.

**Comparison.** Same clips for every model, so paired: bootstrap 95% intervals over clips
for WER differences. Candidates: `base` (baseline), `large-v3-turbo` on CPU `int8` and on GPU
FP16, `large-v3`, and Parakeet if English-only is acceptable. Also test `WHISPER_VAD_FILTER`
on and off, and a fixed `language` against auto-detection.

### 3c. Evaluating TTS models

TTS quality is perceptual, so it needs listening as well as numbers.

**Test set.** 30-50 sentences typical of assistant replies: plain prose, numbers, formulas
written in text, code identifiers, abbreviations ("e.g.", "SQL", "p-value"), and long
sentences.

**Measurements.**

- **Blind listening test (primary)**: for each sentence, the owner hears two engines'
  versions in random order without labels and picks the better one, or rates each 1-5 for
  naturalness and for correct pronunciation. A small script or page can randomise and record
  the choices. Report win rates with intervals.
- **Intelligibility (automatic)**: transcribe each synthesised clip with the chosen STT
  model and compute WER against the input text. High WER flags mispronunciations and
  skipped words; it does not measure naturalness.
- **Time to first audio**: from pressing Read aloud to sound, since playback is sentence by
  sentence; p50 and p95.
- **Real-time factor and resources**: synthesis time per second of audio; CPU or VRAM use.

Candidates: browser voices and SpeechT5 (baselines), Kokoro-82M (CPU), Piper (CPU), and one
larger model if VRAM allows.

**Text preparation is part of the test.** `useReadAloud.ts` strips Markdown symbols but
not, for example, code blocks or LaTeX. Measure with real assistant replies, and record any
text normalisation (skipping code blocks, reading formulas) as a separate variable rather
than mixing it into the model comparison.

### Decision rule

For each direction, adopt a model when:

1. it beats the current default on the primary quality measure (WER and term error rate for
   STT; blind preference for TTS) with an interval that excludes no difference;
2. its p95 latency is within an agreed budget (proposed: dictation transcript within 2 s of
   stopping a 30 s clip; first audio within 1 s); and
3. it fits the server's VRAM or CPU budget alongside the chat and retrieval models.

Quality decides first; speed and resources rule a model out or break ties.

## Order of work

1. Dictation (Part 1 and its tests in 3a), against the current local Whisper. Useful today
   on the laptop.
2. STT evaluation (3b) on the laptop's CPU for `base` against `large-v3-turbo` `int8`, as a
   baseline.
3. Once the server exists: a speech server beside `llama-server`, then 3b and 3c on it.
4. Adopt models by the decision rule; record each choice in `docs/decisions.md` and the
   settings in `docs/guides/assistant-tools.md`.

## Open questions for the owner

1. **Auto-send:** keep dictation insert-only, or offer an optional "send on stop"?
2. **Languages:** English only, or others too? English only makes Parakeet a candidate and
   allows a fixed language setting.
3. **Call mode:** is hands-free spoken conversation (dictation plus automatic read-aloud) a
   goal, or is dictation enough? Call mode raises the latency requirements considerably.
4. **Recording the test set:** willing to record 50-100 clips? Without the owner's own voice
   and vocabulary, the STT comparison would rest on general benchmarks.
5. **Browser recognition:** keep the `web` engine available given that Chromium sends audio
   to Google, or remove it in line with the privacy goal?
