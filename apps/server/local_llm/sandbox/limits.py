"""The fixed limits every sandbox runs under.

These are constants, deliberately not settings: the sandbox is the boundary
around model-written code, and a limit the admin page could loosen would be a
limit a compromised or careless configuration could remove. Changing one is a
code change, reviewed like any other change to the boundary.

The Kata backend (sandbox/kata.py) passes the container limits and the fixed
container options below to Docker as they are, so the whole set is reviewed
in this one file; the command limits are applied by sandbox/exec.py.
"""

from typing import Final

# Container memory limit (`--memory`); Kata sizes the guest VM from it.
MEMORY_LIMIT: Final = '4g'
# Container CPU limit (`--cpus`); Kata sizes the guest's vCPUs from it.
CPU_LIMIT: Final = 2
# The same limit as Docker's `nano_cpus` field, an int64 of billionths of a CPU.
NANO_CPUS: Final = CPU_LIMIT * 1_000_000_000
# Container PID limit (`--pids-limit`); kept, though Kata 4.3.1 runtime-rs does not enforce it.
PIDS_LIMIT: Final = 512
# Per-UID process limit (`--ulimit nproc=512:512`), the fork-bomb bound Kata does enforce.
NPROC_LIMIT: Final = 512
# Size of the `/tmp` tmpfs (`--tmpfs /tmp:size=256m`) on the otherwise read-only root.
TMP_SIZE: Final = '256m'
# Each `/workspace` volume is a fixed-size loop-backed filesystem of this size, so a runaway write cannot fill the
# host's disk; the Kata backend builds it (sandbox/kata.py, an ext4 image on a loop device).
WORKSPACE_SIZE: Final = '10g'
# The unprivileged UID (and GID) every command runs as.
SANDBOX_UID: Final = 1000
# The `--user` value for the container and every exec.
SANDBOX_USER: Final = f'{SANDBOX_UID}:{SANDBOX_UID}'
# Characters kept per stream (stdout, stderr) of one command: the first and last halves.
STREAM_CAP_CHARS: Final = 20_000
# Timeout of a command whose caller gives none, in seconds.
TIMEOUT_DEFAULT_S: Final = 60
# Shortest timeout a command can ask for, in seconds.
TIMEOUT_MIN_S: Final = 1
# Longest timeout a command can ask for, in seconds.
TIMEOUT_MAX_S: Final = 300
# Seconds `timeout` waits after SIGTERM before it sends SIGKILL (`--kill-after`).
KILL_GRACE_S: Final = 5
# Seconds the backend waits past a command's timeout before it ends the exec itself, in case `timeout` hangs.
HOST_DEADLINE_SLACK_S: Final = 10
# Largest command, in UTF-8 bytes: it is one argv element, and the kernel refuses an argument over 128 KiB
# (MAX_ARG_STRLEN), so a longer script goes into a file instead.
MAX_COMMAND_BYTES: Final = 100_000
# Largest output file read back from a sandbox, in bytes (50 MiB).
OUTPUT_FILE_CAP_BYTES: Final = 50 * 1024 * 1024
# Most bytes one `bash` call attaches from /workspace/outputs, over all its files (200 MiB; sandbox/outputs.py).
OUTPUT_CALL_CAP_BYTES: Final = 200 * 1024 * 1024
# Most bytes of sandbox outputs a chat holds, over all its calls, previews included (1 GiB; owner decision Q22): the
# sum of the File rows marked `sandbox_output` linked to the chat, or, for an unsaved chat, of those its running
# sandbox stored. A file that would pass it is not attached.
OUTPUT_CHAT_CAP_BYTES: Final = 1024 * 1024 * 1024
# Most files one `bash` call attaches; each becomes a File row on the message.
OUTPUT_MAX_FILES: Final = 20
# Most PDFs one `bash` call renders previews for; each render is a helper exec of up to HELPER_TIMEOUT_S.
PREVIEW_MAX_PDFS: Final = 3
# Pages previewed per PDF, from the first (`pdftoppm -l`).
PREVIEW_MAX_PAGES: Final = 10
# Resolution of a preview, in dots per inch (`pdftoppm -r`).
PREVIEW_DPI: Final = 80
# Widest and tallest preview, in pixels (`pdftoppm -W -H`): a larger page is cropped to its top-left corner rather
# than scaled, so a normal page keeps PREVIEW_DPI and a huge one is never rasterised whole (a 200-inch page at
# 80 dpi would be 16,000 pixels a side, about 1 GB of memory).
PREVIEW_MAX_SIDE: Final = 1600
# Largest preview PNG kept, in bytes.
PREVIEW_MAX_BYTES: Final = 8 * 1024 * 1024
# Largest HTML output GET /api/v1/sandbox/outputs/{id}/html returns, in bytes (5 MiB).
HTML_MAX_BYTES: Final = 5 * 1024 * 1024
# Most seconds a session waits for a cancelled backend call to end (the post-exec kill, or a put, read or stat
# already under way) before it gives the sandbox up as in doubt, which stops it before the chat's lock is released.
CANCEL_WAIT_S: Final = 30

# The file tools' limits (sandbox/workspace.py).

# Longest path a file tool accepts or resolves to, in UTF-8 bytes (PATH_MAX); infra/sandbox/common/lllm-path's
# MAX_BYTES must equal it, which tests/test_sandbox_tools.py checks.
MAX_PATH_BYTES: Final = 4096
# Timeout of each guest helper the file tools run (lllm-path, the read check, the listing, the write), in seconds.
HELPER_TIMEOUT_S: Final = 30
# The workspace listing the deletion dialog shows (T24): at most this many files are listed, with a total of all.
LIST_MAX_ENTRIES: Final = 300
# The most UTF-8 bytes of a path the listing shows; a longer one is cut, ending in an ellipsis, and marked as cut.
LIST_PATH_MAX_BYTES: Final = 1024
# Largest file `view` or `str_replace` reads, in bytes (10 MiB).
VIEW_MAX_BYTES: Final = 10 * 1024 * 1024
# Largest image `view` returns, in bytes: its data URI is stored with the chat and sent with every later request.
IMAGE_MAX_BYTES: Final = 2 * 1024 * 1024
# Widest or tallest image `view` returns, in pixels, by its header.
IMAGE_MAX_SIDE: Final = 8192
# Most pixels an image `view` returns may have, by its header, so a small file cannot decode to a huge picture.
IMAGE_MAX_PIXELS: Final = 40_000_000

# The package telemetry's limits (sandbox/telemetry.py, T21).

# Most bytes one read of the pip mirror's access log returns (SandboxBackend.mirror_log); the rest waits for the next.
MIRROR_LOG_MAX_BYTES: Final = 1024 * 1024

# The fixed container options.

# Capabilities dropped (`--cap-drop`): all of them, so root in the guest cannot override file permissions or signal
# another user's processes.
CAP_DROP: Final = ('ALL',)
# Security options (`--security-opt`): no exec can gain privileges through a setuid binary.
SECURITY_OPT: Final = ('no-new-privileges',)
# The image's root filesystem is mounted read-only (`--read-only`); only `/workspace` and `/tmp` are writable.
READ_ONLY_ROOT: Final = True
# Where the chat's volume is mounted, and every command's working directory.
WORKSPACE: Final = '/workspace'
