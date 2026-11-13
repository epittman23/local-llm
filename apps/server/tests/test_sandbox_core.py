"""The sandbox core (local_llm/sandbox): the command wrapper, the output cap, the result rules, the fake backend.

Pins, without Docker or Kata:

- `wrap_argv` and `wrap_command` clamp the timeout to 1..300, build the
  `/usr/bin/timeout --kill-after=5 <t>` prefix, refuse NUL, an oversized
  command and arguments of the wrong type, and `require_wrapped` (and so
  every `exec`) accepts exactly what they build for a timeout already
  clamped, refusing one outside 1..300;
- `StreamCap` keeps exactly the first and last halves of its limit, renders
  the truncation marker with the right count, handles split UTF-8, and stays
  bounded in memory on a 10 MB stream;
- `result_from` reads 124 and 137 as a timeout only after the time `timeout`
  needs to have produced them, or when the host deadline fired;
- chat ids, specs, labels, images, the ephemeral flag, paths and the
  create, put_files and get_files arguments are validated before anything
  uses them;
- `FakeBackend` honours the SandboxBackend contract, with the Protocol's
  exact signatures: files survive `stop()` and not `destroy()`, the image
  and ephemeral flag come back from `list_sandboxes()`, `last_used` moves
  only when a container starts, `put_files` leaves exactly the given
  root-owned files, the guest root (`/etc` read-only, `/tmp` writable and
  emptied at every start) and the permission checks behave as the kernel's,
  nothing runs in a chat with no running sandbox, a sandbox that dies during
  a command raises instead of returning a result, UID 1000's processes are
  killed after every exec, calls are recorded, and the default interpreter
  behaves like the bash subset it documents;
- the value types are frozen and the limits are the ones the plan fixes.

Run from apps/server:

    python -m pytest tests/test_sandbox_core.py
"""

import asyncio
import dataclasses
import datetime as dt
import errno
import inspect
import time
import tracemalloc
from collections.abc import Callable, Iterator

import pydantic
import pytest

import local_llm.sandbox as sandbox_pkg
from local_llm.sandbox import (
    ExecResult,
    FileStat,
    SandboxBackend,
    SandboxNotRunning,
    SandboxSpec,
    SandboxUnavailable,
    StreamCap,
    clamp_timeout,
    limits,
    require_wrapped,
    result_from,
    validate_chat_id,
    volume_name,
    wrap_argv,
    wrap_command,
)
from local_llm.sandbox.fake import (
    FakeBackend,
    FakeExecRequest,
    FakeFile,
    FakeRun,
    FakeWorkspace,
    guest_root,
    interpret,
)

MARKER = '\n[... {n} characters truncated ...]\n'

CHAT = '11111111-1111-4111-8111-111111111111'
OTHER = '22222222-2222-4222-8222-222222222222'
GHOST = '33333333-3333-4333-8333-333333333333'
UPPER = 'AAAAAAAA-1111-4111-8111-111111111111'
PASSWD = b'root:x:0:0:root:/root:/bin/bash\n'
TIMEOUT = '/usr/bin/timeout'
BASH = ['/bin/bash', '-lc', '--']


# Helpers.


class _StrSubclass(str):
    pass


def _spec(chat_id: str = CHAT, image: sandbox_pkg.ImageKey = 'data', ephemeral: bool = False) -> SandboxSpec:
    return SandboxSpec(chat_id, image, {'app': 'test'}, ephemeral)


async def _started(script=None, chat_id: str = CHAT) -> FakeBackend:
    backend = FakeBackend(script)
    await backend.create(chat_id, _spec(chat_id))
    return backend


async def _sh(backend: FakeBackend, command: str, timeout_s: int = 60, stdin: bytes | None = None) -> ExecResult:
    return await backend.exec(CHAT, wrap_command(command, timeout_s), timeout_s, stdin)


def _run_sh(command: str, timeout_s: int = 60, stdin: bytes | None = None) -> ExecResult:
    async def go() -> ExecResult:
        return await _sh(await _started(), command, timeout_s, stdin)

    return asyncio.run(go())


def _pattern_text(start: int, stop: int) -> str:
    # Character i of the test streams is chr(33 + i % 89): printable ASCII, so
    # one byte per character, with a period (89) that no chunk size shares.
    return ''.join(chr(33 + i % 89) for i in range(start, stop))


def _pattern_chunks(total: int, size: int) -> Iterator[bytes]:
    base = bytes(33 + j for j in range(89))
    for offset in range(0, total, size):
        n = min(size, total - offset)
        shift = offset % 89
        yield (base * (n // 89 + 2))[shift : shift + n]


def _capped(data: bytes, limit: int = 20_000) -> StreamCap:
    cap = StreamCap(limit)
    cap.feed(data)
    return cap


def _workspace() -> FakeWorkspace:
    return FakeWorkspace({'/workspace': FakeFile(content=None, uid=1000, mode=0o755)})


# wrap_argv, wrap_command, require_wrapped and clamp_timeout.


@pytest.mark.parametrize(
    ('requested', 'clamped'),
    [(60, 60), (1, 1), (300, 300), (0, 1), (-5, 1), (301, 300), (10**9, 300)],
)
def test_wrappers_clamp_timeout_to_1_through_300(requested, clamped):
    assert wrap_command('true', requested)[2] == str(clamped)
    assert wrap_argv(['true'], requested)[2] == str(clamped)
    assert clamp_timeout(requested) == clamped


@pytest.mark.parametrize('bad', [True, False, 1.0, 60.5, '60', None])
def test_clamp_timeout_and_the_wrappers_refuse_a_timeout_that_is_not_an_int(bad):
    valid = wrap_argv(['true'], 60)
    for call in (
        lambda: clamp_timeout(bad),
        lambda: wrap_argv(['true'], bad),
        lambda: wrap_command('true', bad),
        lambda: require_wrapped(valid, bad),
    ):
        with pytest.raises(TypeError, match='int'):
            call()


def test_wrap_argv_builds_the_documented_argv():
    assert wrap_argv(['echo', 'hi'], 30) == [TIMEOUT, '--kill-after=5', '30', 'echo', 'hi']


def test_wrap_argv_refuses_an_empty_argv():
    with pytest.raises(ValueError, match='empty'):
        wrap_argv([], 30)


def test_wrap_argv_refuses_an_element_with_nul():
    with pytest.raises(ValueError, match='NUL'):
        wrap_argv(['echo', 'a\0b'], 30)


def test_wrap_argv_refuses_an_element_that_is_not_a_str():
    with pytest.raises(TypeError, match='str'):
        wrap_argv(['echo', b'hi'], 30)


@pytest.mark.parametrize('argv', ['echo hi', '', ('echo', 'hi'), None, b'echo'])
def test_wrap_argv_refuses_an_argv_that_is_not_a_list(argv):
    # A str in particular must not be split into one argument per character.
    with pytest.raises(TypeError, match='list of str'):
        wrap_argv(argv, 30)


@pytest.mark.parametrize('command', [b'echo hi', None, ['echo', 'hi'], 5, _StrSubclass('echo hi')])
def test_wrap_command_refuses_a_command_that_is_not_exactly_a_str(command):
    with pytest.raises(TypeError, match='command must be a str'):
        wrap_command(command, 30)


def test_wrap_command_builds_the_documented_argv():
    assert wrap_command('echo hi', 30) == [TIMEOUT, '--kill-after=5', '30', '/bin/bash', '-lc', '--', 'echo hi']


@pytest.mark.parametrize(
    'command',
    [
        '',
        'echo "$(rm -rf /)"; `id` | tee \'x\' && exit 1 || true',
        'cat <<EOF\n$HOME "quoted" \'single\'\nEOF\n\techo done\n',
        'echo \'it\'\'s\' "a \\"b\\"" $((1+2)) ${PATH:-x} > /dev/null 2>&1 &',
        '  leading and trailing space  ',
        '-rf',
    ],
)
def test_wrap_command_passes_the_command_as_one_untouched_element(command):
    argv = wrap_command(command, 10)
    assert len(argv) == 7
    assert argv[:6] == [TIMEOUT, '--kill-after=5', '10', '/bin/bash', '-lc', '--']
    assert argv[6] == command


def test_wrap_command_accepts_a_command_of_exactly_the_byte_limit():
    assert wrap_command('a' * 100_000, 10)[6] == 'a' * 100_000


def test_wrap_command_counts_utf8_bytes_not_characters():
    assert wrap_command('€' * 33_333, 10)[6] == '€' * 33_333
    with pytest.raises(ValueError, match='100002 bytes'):
        wrap_command('€' * 33_334, 10)


def test_wrap_command_over_the_limit_tells_the_model_to_use_write_file():
    with pytest.raises(ValueError, match='write_file') as info:
        wrap_command('a' * 100_001, 10)
    assert '100001 bytes' in str(info.value)
    assert '100000-byte limit' in str(info.value)


def test_wrap_command_refuses_nul():
    with pytest.raises(ValueError, match='NUL'):
        wrap_command('echo a\0b', 10)


def test_require_wrapped_accepts_what_the_wrappers_build():
    require_wrapped(wrap_command('echo hi', 30), 30)
    require_wrapped(wrap_argv(['echo', 'hi'], 30), 30)


@pytest.mark.parametrize('timeout_s', [1, 300])
def test_require_wrapped_accepts_the_bounds_of_the_timeout_range(timeout_s):
    require_wrapped(wrap_command('x', timeout_s), timeout_s)


@pytest.mark.parametrize('timeout_s', [0, -1, 301, 500])
def test_require_wrapped_refuses_a_timeout_outside_1_through_300(timeout_s):
    with pytest.raises(ValueError, match=r'outside 1\.\.300'):
        require_wrapped([TIMEOUT, '--kill-after=5', str(timeout_s), *BASH, 'x'], timeout_s)


def test_require_wrapped_refuses_an_unclamped_timeout_even_with_the_argv_the_wrapper_built_for_it():
    # The wrapper clamps 400 to 300; exec must be given that same 300, not 400 or 500.
    argv = wrap_command('x', 400)
    assert argv[2] == '300'
    for timeout_s in (400, 500):
        with pytest.raises(ValueError, match=r'outside 1\.\.300'):
            require_wrapped(argv, timeout_s)
    require_wrapped(argv, clamp_timeout(400))


@pytest.mark.parametrize(
    'argv',
    [
        [],
        ['echo', 'hi'],
        [TIMEOUT, '--kill-after=5', '30'],
        [TIMEOUT, '--kill-after=5', '31', 'echo'],
        [TIMEOUT, '--kill-after=9', '30', 'echo'],
        [TIMEOUT, '30', 'echo'],
        ['timeout', '--kill-after=5', '30', 'echo'],
        ['/bin/timeout', '--kill-after=5', '30', 'echo'],
        ['/bin/bash', TIMEOUT, '--kill-after=5', '30', 'echo'],
        (TIMEOUT, '--kill-after=5', '30', 'echo'),
        [TIMEOUT, '--kill-after=5', '30', 'echo', 'a\0b'],
    ],
)
def test_require_wrapped_refuses_an_argv_that_is_not_wrapped_for_the_timeout(argv):
    with pytest.raises(ValueError):
        require_wrapped(argv, 30)


def test_require_wrapped_refuses_an_element_that_is_not_a_str():
    with pytest.raises(TypeError, match='str'):
        require_wrapped([TIMEOUT, '--kill-after=5', '30', 'echo', 5], 30)


# StreamCap.


def test_stream_cap_keeps_exactly_head_and_tail_of_ten_megabytes():
    total = 10_000_000
    cap = StreamCap()
    for chunk in _pattern_chunks(total, 65_536):
        cap.feed(chunk)
    expected = _pattern_text(0, 10_000) + MARKER.format(n=total - 20_000) + _pattern_text(total - 10_000, total)
    assert cap.render() == expected
    assert cap.truncated is True


def test_stream_cap_marker_counts_the_dropped_characters():
    cap = StreamCap()
    for chunk in _pattern_chunks(10_000_000, 1_000_000):
        cap.feed(chunk)
    assert '\n[... 9980000 characters truncated ...]\n' in cap.render()


def test_stream_cap_stays_bounded_in_memory_on_ten_megabytes():
    cap = StreamCap()
    tracemalloc.start()
    try:
        for chunk in _pattern_chunks(10_000_000, 65_536):
            cap.feed(chunk)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert peak < 2_000_000


@pytest.mark.parametrize('chunk_size', [1, 7, 4096, 25_000])
def test_stream_cap_result_does_not_depend_on_the_chunk_size(chunk_size):
    data = _pattern_text(0, 25_000).encode()
    cap = StreamCap()
    for i in range(0, len(data), chunk_size):
        cap.feed(data[i : i + chunk_size])
    assert cap.render() == _pattern_text(0, 10_000) + MARKER.format(n=5_000) + _pattern_text(15_000, 25_000)


@pytest.mark.parametrize('length', [0, 1, 9_999, 10_000, 10_001, 15_000, 19_999, 20_000])
def test_stream_cap_does_not_truncate_output_up_to_the_limit(length):
    text = _pattern_text(0, length)
    cap = _capped(text.encode())
    assert cap.render() == text
    assert cap.truncated is False


def test_stream_cap_truncates_output_one_character_over_the_limit():
    cap = _capped(_pattern_text(0, 20_001).encode())
    assert cap.render() == _pattern_text(0, 10_000) + MARKER.format(n=1) + _pattern_text(10_001, 20_001)
    assert cap.truncated is True


def test_stream_cap_splits_a_small_limit_into_head_and_tail_halves():
    cap = _capped(b'abcdefghijklmno', limit=10)
    assert cap.render() == 'abcde' + MARKER.format(n=5) + 'klmno'


def test_stream_cap_gives_the_odd_character_of_an_odd_limit_to_the_tail():
    cap = _capped(b'abcdefghij', limit=5)
    assert cap.render() == 'ab' + MARKER.format(n=5) + 'hij'


def test_stream_cap_accepts_the_smallest_limit_of_2():
    assert _capped(b'abc', limit=2).render() == 'a' + MARKER.format(n=1) + 'c'


@pytest.mark.parametrize('limit', [1, 0, -1])
def test_stream_cap_refuses_a_limit_below_2(limit):
    with pytest.raises(ValueError, match='below 2'):
        StreamCap(limit)


def test_stream_cap_with_no_input_renders_empty():
    cap = StreamCap()
    assert cap.render() == ''
    assert cap.truncated is False


@pytest.mark.parametrize('text', ['a€b', 'x\U0001f600y', 'é€\U0001f600'])
def test_stream_cap_keeps_a_multibyte_character_split_across_chunks(text):
    cap = StreamCap()
    for byte in text.encode():
        cap.feed(bytes([byte]))
    assert cap.render() == text


def test_stream_cap_counts_characters_not_bytes():
    at_limit = _capped('€'.encode() * 20_000)
    assert at_limit.render() == '€' * 20_000
    assert at_limit.truncated is False
    over = _capped('€'.encode() * 20_001)
    assert over.render() == '€' * 10_000 + MARKER.format(n=1) + '€' * 10_000


def test_stream_cap_replaces_invalid_bytes_with_the_replacement_character():
    assert _capped(b'a\xffb').render() == 'a�b'


def test_stream_cap_flushes_a_trailing_incomplete_character_as_one_replacement():
    assert _capped(b'a\xe2\x82').render() == 'a�'


def test_stream_cap_render_is_idempotent():
    cap = _capped(b'abc')
    assert cap.render() == cap.render() == 'abc'


def test_stream_cap_truncated_can_be_read_before_render():
    cap = _capped(b'a' * 30_000)
    assert cap.truncated is True
    assert cap.render() == 'a' * 10_000 + MARKER.format(n=10_000) + 'a' * 10_000


def test_stream_cap_feed_after_render_raises_value_error():
    cap = _capped(b'abc')
    cap.render()
    with pytest.raises(ValueError, match='feed'):
        cap.feed(b'more')


def test_stream_cap_feed_after_truncated_is_read_raises_value_error():
    cap = _capped(b'abc')
    assert cap.truncated is False
    with pytest.raises(ValueError, match='feed'):
        cap.feed(b'more')


def test_stream_cap_decodes_one_huge_chunk_in_slices_without_losing_a_split_character():
    # The euro sign straddles the 64 KiB slice boundary (bytes 65535 to 65537).
    data = b'a' * 65_535 + '€'.encode() + b'b' * 100_000
    cap = _capped(data, limit=200_000)
    assert cap.render() == 'a' * 65_535 + '€' + 'b' * 100_000
    assert cap.truncated is False


def test_stream_cap_truncates_one_huge_chunk_to_its_head_and_tail():
    cap = _capped(b'a' * 100_000 + b'b' * 100_000)
    assert cap.render() == 'a' * 10_000 + MARKER.format(n=180_000) + 'b' * 10_000


# result_from.


def _result(returncode: int, elapsed_s: float, timeout_s: int = 60, deadline_hit: bool = False) -> ExecResult:
    return result_from(
        returncode,
        stdout=_capped(b'out'),
        stderr=_capped(b'err'),
        elapsed_s=elapsed_s,
        timeout_s=timeout_s,
        deadline_hit=deadline_hit,
    )


@pytest.mark.parametrize('elapsed_s', [60.0, 60.5, 120.0])
def test_result_from_maps_124_after_the_timeout_to_timed_out(elapsed_s):
    assert _result(124, elapsed_s).timed_out is True


@pytest.mark.parametrize('elapsed_s', [0.0, 0.1, 59.999])
def test_result_from_does_not_map_an_early_124_to_timed_out(elapsed_s):
    assert _result(124, elapsed_s).timed_out is False


def test_result_from_maps_137_at_exactly_timeout_plus_grace_to_timed_out():
    assert _result(137, 65.0).timed_out is True


def test_result_from_maps_137_after_timeout_plus_grace_to_timed_out():
    assert _result(137, 120.0).timed_out is True


@pytest.mark.parametrize('elapsed_s', [0.0, 3.0, 60.0, 64.999])
def test_result_from_does_not_map_an_early_137_to_timed_out(elapsed_s):
    assert _result(137, elapsed_s).timed_out is False


@pytest.mark.parametrize(
    ('returncode', 'timeout_s', 'threshold'),
    [(137, 0, 6.0), (137, -3, 6.0), (137, 10, 15.0), (137, 1000, 305.0), (124, 0, 1.0), (124, 1000, 300.0)],
)
def test_result_from_uses_the_clamped_timeout_for_the_124_and_137_rules(returncode, timeout_s, threshold):
    assert _result(returncode, threshold, timeout_s).timed_out is True
    assert _result(returncode, threshold - 0.001, timeout_s).timed_out is False


@pytest.mark.parametrize('returncode', [0, 1, 2, 126, 127, 143])
def test_result_from_does_not_map_other_return_codes_to_timed_out(returncode):
    assert _result(returncode, 1000.0).timed_out is False


@pytest.mark.parametrize('returncode', [0, 1, 124, 137, -9])
def test_result_from_maps_a_host_deadline_hit_to_timed_out_whatever_the_code_and_time(returncode):
    assert _result(returncode, 0.0, deadline_hit=True).timed_out is True


def test_result_from_without_a_deadline_hit_by_default_does_not_time_out_a_quick_success():
    assert _result(0, 1.0).timed_out is False


def test_result_from_carries_return_code_streams_and_duration():
    result = _result(3, 2.3456)
    assert (result.returncode, result.stdout, result.stderr, result.duration_ms) == (3, 'out', 'err', 2346)
    assert result.truncated is False


@pytest.mark.parametrize(
    ('stdout_len', 'stderr_len', 'truncated'),
    [(20_000, 20_000, False), (20_001, 0, True), (0, 20_001, True), (30_000, 30_000, True)],
)
def test_result_from_sets_truncated_when_either_stream_lost_characters(stdout_len, stderr_len, truncated):
    result = result_from(
        0,
        stdout=_capped(b'o' * stdout_len),
        stderr=_capped(b'e' * stderr_len),
        elapsed_s=0.0,
        timeout_s=60,
    )
    assert result.truncated is truncated


def test_result_from_refuses_the_same_stream_cap_for_both_streams():
    cap = _capped(b'x')
    with pytest.raises(ValueError, match='different'):
        result_from(0, stdout=cap, stderr=cap, elapsed_s=0.0, timeout_s=60)


@pytest.mark.parametrize('elapsed_s', [float('nan'), float('inf'), float('-inf'), -0.001, -1.0])
def test_result_from_refuses_an_elapsed_time_that_is_negative_or_not_finite(elapsed_s):
    with pytest.raises(ValueError, match='elapsed_s'):
        _result(0, elapsed_s)


def test_result_from_leaves_both_streams_unfinished_when_it_refuses_a_call():
    out, err = StreamCap(), StreamCap()
    with pytest.raises(ValueError):
        result_from(0, stdout=out, stderr=err, elapsed_s=-1.0, timeout_s=60)
    out.feed(b'still open')
    err.feed(b'still open')


@pytest.mark.parametrize('bad', [True, 60.0, '60'])
def test_result_from_refuses_a_timeout_that_is_not_an_int(bad):
    with pytest.raises(TypeError, match='int'):
        _result(0, 1.0, timeout_s=bad)


# Types and limits.

UUID_ERROR = 'canonical lowercase UUID'


def test_validate_chat_id_returns_a_canonical_uuid_unchanged():
    assert validate_chat_id(CHAT) == CHAT


@pytest.mark.parametrize(
    'bad',
    [
        'c1',
        '',
        '11111111-1111-4111-8111-11111111111G',
        '11111111111141118111111111111111',
        '{11111111-1111-4111-8111-111111111111}',
        'urn:uuid:11111111-1111-4111-8111-111111111111',
        ' 11111111-1111-4111-8111-111111111111',
        '11111111-1111-4111-8111-111111111111\n',
        '11111111-1111-4111-8111-111111111111\0',
        'ABCDEF01-1111-4111-8111-111111111111',
        '../../etc',
        123,
        None,
        b'11111111-1111-4111-8111-111111111111',
    ],
)
def test_validate_chat_id_refuses_anything_but_a_canonical_lowercase_uuid(bad):
    with pytest.raises(ValueError, match=UUID_ERROR):
        validate_chat_id(bad)


def test_validate_chat_id_returns_a_plain_str_for_a_str_subclass():
    validated = validate_chat_id(_StrSubclass(CHAT))
    assert type(validated) is str
    assert validated == CHAT


def test_sandbox_spec_stores_a_str_subclass_chat_id_as_a_plain_str():
    spec = SandboxSpec(_StrSubclass(CHAT), 'data')
    assert type(spec.chat_id) is str
    assert spec.chat_id == CHAT


def test_volume_name_is_the_prefix_and_the_chat_id():
    assert volume_name(CHAT) == 'lllm-sandbox-11111111-1111-4111-8111-111111111111'


def test_volume_name_refuses_a_chat_id_that_is_not_a_uuid():
    with pytest.raises(ValueError, match=UUID_ERROR):
        volume_name('c1')


def test_sandbox_spec_derives_its_volume_from_the_chat_id():
    assert _spec(OTHER).volume == 'lllm-sandbox-22222222-2222-4222-8222-222222222222'


def test_sandbox_spec_refuses_a_volume_since_it_is_derived():
    with pytest.raises(TypeError, match='volume'):
        SandboxSpec(CHAT, 'data', volume='lllm-sandbox-other')


def test_sandbox_spec_is_not_ephemeral_by_default():
    assert SandboxSpec(CHAT, 'data').ephemeral is False


def test_sandbox_spec_accepts_ephemeral_true():
    assert SandboxSpec(CHAT, 'data', ephemeral=True).ephemeral is True


@pytest.mark.parametrize('bad', [1, 0, 'yes', '', None, 1.0])
def test_sandbox_spec_refuses_an_ephemeral_flag_that_is_not_a_bool(bad):
    with pytest.raises(TypeError, match='ephemeral must be a bool'):
        SandboxSpec(CHAT, 'data', ephemeral=bad)


def test_sandbox_specs_that_differ_only_in_ephemeral_are_different():
    assert _spec() != _spec(ephemeral=True)
    assert len({_spec(), _spec(ephemeral=True)}) == 2


def test_sandbox_spec_is_frozen():
    with pytest.raises(dataclasses.FrozenInstanceError):
        _spec().image = 'web'


def test_sandbox_spec_labels_are_read_only():
    spec = _spec()
    with pytest.raises(TypeError):
        spec.labels['app'] = 'changed'
    assert spec.labels['app'] == 'test'


def test_sandbox_spec_copies_the_labels_it_is_given():
    labels = {'app': 'test'}
    spec = SandboxSpec(CHAT, 'data', labels)
    labels['app'] = 'changed'
    labels['extra'] = 'x'
    assert dict(spec.labels) == {'app': 'test'}


def test_sandbox_spec_defaults_to_no_labels():
    assert dict(SandboxSpec(CHAT, 'data').labels) == {}


def test_sandbox_spec_is_hashable_and_equal_specs_hash_alike():
    assert hash(_spec()) == hash(_spec())
    assert {_spec(): 1}[_spec()] == 1


def test_sandbox_spec_hash_leaves_the_labels_out_but_equality_compares_them():
    first = SandboxSpec(CHAT, 'data', {'a': '1'})
    second = SandboxSpec(CHAT, 'data', {'b': '2'})
    assert hash(first) == hash(second)
    assert first != second
    assert len({first, second}) == 2


def test_sandbox_specs_with_another_chat_or_image_are_different():
    assert _spec() != _spec(OTHER)
    assert _spec() != _spec(image='web')


@pytest.mark.parametrize('bad', ['c1', '', UPPER, CHAT.replace('-', ''), 5, None])
def test_sandbox_spec_refuses_a_chat_id_that_is_not_a_canonical_uuid(bad):
    with pytest.raises(ValueError, match=UUID_ERROR):
        SandboxSpec(bad, 'data')


@pytest.mark.parametrize('bad', ['other', 'DATA', '', 'data ', 'data\0', None, 5, _StrSubclass('data')])
def test_sandbox_spec_refuses_an_image_that_is_not_in_image_key(bad):
    with pytest.raises(ValueError, match='image'):
        SandboxSpec(CHAT, bad)


@pytest.mark.parametrize('image', ['data', 'web'])
def test_sandbox_spec_accepts_each_image_key(image):
    assert SandboxSpec(CHAT, image).image == image


@pytest.mark.parametrize('key', ['lllm.chat', 'lllm.image', 'lllm.ephemeral', 'lllm.', 'lllm.anything'])
def test_sandbox_spec_refuses_a_label_key_with_the_reserved_prefix(key):
    with pytest.raises(ValueError, match='reserved prefix'):
        SandboxSpec(CHAT, 'data', {key: 'x'})


@pytest.mark.parametrize('labels', [{'lllm': 'x'}, {'Lllm.chat': 'x'}, {'xlllm.chat': 'x'}, {'a.lllm.b': 'x'}])
def test_sandbox_spec_accepts_a_label_key_that_only_resembles_the_reserved_prefix(labels):
    assert dict(SandboxSpec(CHAT, 'data', labels).labels) == labels


@pytest.mark.parametrize(
    'labels',
    [
        {'': 'x'},
        {'k': ''},
        {'k\0': 'x'},
        {'k': 'v\0'},
        {'k': 5},
        {5: 'v'},
        {'k': None},
        {'k': b'v'},
        {_StrSubclass('k'): 'v'},
        {'k': _StrSubclass('v')},
    ],
)
def test_sandbox_spec_refuses_a_label_that_is_not_a_non_empty_string_without_nul(labels):
    with pytest.raises(ValueError, match='not a non-empty string without NUL'):
        SandboxSpec(CHAT, 'data', labels)


def test_exec_result_is_frozen():
    result = _result(0, 1.0)
    with pytest.raises(pydantic.ValidationError):
        result.returncode = 1


def test_package_root_exports_every_name_in_all():
    assert all(hasattr(sandbox_pkg, name) for name in sandbox_pkg.__all__)


def test_package_root_does_not_export_the_fake_backend_or_the_limits():
    limit_names = {name for name in vars(limits) if name.isupper()}
    assert 'TIMEOUT_MAX_S' in limit_names
    exported = set(sandbox_pkg.__all__)
    assert exported.isdisjoint({'FakeBackend', 'fake', 'limits'})
    assert exported.isdisjoint(limit_names)


@pytest.mark.parametrize(
    ('name', 'value'),
    [
        ('MEMORY_LIMIT', '4g'),
        ('CPU_LIMIT', 2),
        ('NANO_CPUS', 2_000_000_000),
        ('PIDS_LIMIT', 512),
        ('NPROC_LIMIT', 512),
        ('TMP_SIZE', '256m'),
        ('WORKSPACE_SIZE', '10g'),
        ('SANDBOX_UID', 1000),
        ('SANDBOX_USER', '1000:1000'),
        ('STREAM_CAP_CHARS', 20_000),
        ('TIMEOUT_DEFAULT_S', 60),
        ('TIMEOUT_MIN_S', 1),
        ('TIMEOUT_MAX_S', 300),
        ('KILL_GRACE_S', 5),
        ('HOST_DEADLINE_SLACK_S', 10),
        ('MAX_COMMAND_BYTES', 100_000),
        ('OUTPUT_FILE_CAP_BYTES', 52_428_800),
        ('CAP_DROP', ('ALL',)),
        ('SECURITY_OPT', ('no-new-privileges',)),
        ('READ_ONLY_ROOT', True),
        ('WORKSPACE', '/workspace'),
    ],
)
def test_limits_have_the_values_the_plan_fixes(name, value):
    assert getattr(limits, name) == value
    assert type(getattr(limits, name)) is type(value)


def test_fake_backend_satisfies_the_sandbox_backend_protocol():
    assert isinstance(FakeBackend(), SandboxBackend)


def test_an_unrelated_object_does_not_satisfy_the_sandbox_backend_protocol():
    assert not isinstance(object(), SandboxBackend)


_BACKEND_METHODS = [
    'create',
    'destroy',
    'exec',
    'get_files',
    'list_sandboxes',
    'list_workspace',
    'mirror_log',
    'put_files',
    'put_uploads',
    'ready',
    'remove_helpers',
    'stat',
    'stop',
]


def test_sandbox_backend_declares_exactly_the_documented_methods():
    assert sorted(name for name in vars(SandboxBackend) if not name.startswith('_')) == _BACKEND_METHODS


@pytest.mark.parametrize('name', _BACKEND_METHODS)
def test_fake_backend_methods_match_the_protocols_signatures_and_are_coroutine_functions(name):
    # The tests are not type-checked in CI, so this is what keeps the fake from drifting from the interface.
    protocol_method, fake_method = getattr(SandboxBackend, name), getattr(FakeBackend, name)
    assert inspect.signature(fake_method) == inspect.signature(protocol_method)
    assert inspect.iscoroutinefunction(protocol_method)
    assert inspect.iscoroutinefunction(fake_method)


# FakeWorkspace.


def test_workspace_read_returns_a_readable_file():
    ws = _workspace()
    ws.files['/workspace/a.txt'] = FakeFile(b'data', uid=1000, mode=0o644)
    assert ws.read('a.txt') == b'data'
    assert ws.read('/workspace/a.txt') == b'data'


def test_workspace_resolve_normalises_relative_and_double_slash_paths():
    assert FakeWorkspace.resolve('a/../b') == '/workspace/b'
    assert FakeWorkspace.resolve('//etc/passwd') == '/etc/passwd'
    assert FakeWorkspace.resolve('/workspace/./x') == '/workspace/x'


def test_workspace_read_of_a_missing_file_raises_enoent():
    with pytest.raises(FileNotFoundError) as info:
        _workspace().read('nope')
    assert info.value.errno == errno.ENOENT


def test_workspace_read_of_a_directory_raises_eisdir():
    with pytest.raises(IsADirectoryError) as info:
        _workspace().read('/workspace')
    assert info.value.errno == errno.EISDIR


def test_workspace_read_with_a_file_as_parent_raises_enotdir():
    ws = _workspace()
    ws.files['/workspace/f'] = FakeFile(b'', uid=1000, mode=0o644)
    with pytest.raises(NotADirectoryError) as info:
        ws.read('f/x')
    assert info.value.errno == errno.ENOTDIR


def test_workspace_read_of_a_root_only_file_raises_eacces_for_uid_1000():
    ws = _workspace()
    ws.files['/workspace/secret'] = FakeFile(b'x', uid=0, mode=0o600)
    with pytest.raises(PermissionError) as info:
        ws.read('secret')
    assert info.value.errno == errno.EACCES


def test_workspace_read_of_a_root_only_file_succeeds_for_its_owner():
    ws = _workspace()
    ws.files['/workspace/secret'] = FakeFile(b'x', uid=0, mode=0o600)
    assert ws.read('secret', uid=0) == b'x'


def test_workspace_read_of_the_guests_etc_passwd_succeeds_for_uid_1000():
    assert _workspace().read('/etc/passwd') == PASSWD


def test_workspace_guest_root_is_root_owned_with_a_sticky_world_writable_tmp():
    rootfs = _workspace().rootfs
    assert {path: (entry.uid, entry.mode) for path, entry in rootfs.items()} == {
        '/': (0, 0o755),
        '/etc': (0, 0o755),
        '/etc/passwd': (0, 0o644),
        '/tmp': (0, 0o1777),
    }
    assert rootfs['/etc/passwd'].content == PASSWD


def test_guest_root_returns_a_fresh_copy_each_time():
    first, second = guest_root(), guest_root()
    first['/tmp/x'] = FakeFile(b'x', uid=1000, mode=0o644)
    first['/etc/passwd'].content = b'changed'
    assert '/tmp/x' not in second
    assert second['/etc/passwd'].content == PASSWD


@pytest.mark.parametrize('path', ['/etc/x', '../etc/x', '/workspace/../etc/x', '/etc/passwd', '/newdir', '/tmpx'])
def test_workspace_write_outside_workspace_and_tmp_raises_erofs(path):
    ws = _workspace()
    with pytest.raises(OSError) as info:
        ws.write(path, b'x')
    assert info.value.errno == errno.EROFS
    assert ws.rootfs['/etc/passwd'].content == PASSWD


def test_workspace_write_under_tmp_creates_a_file_owned_by_uid_1000():
    ws = _workspace()
    ws.write('/tmp/x', b'scratch')
    entry = ws.rootfs['/tmp/x']
    assert (entry.content, entry.uid, entry.mode) == (b'scratch', 1000, 0o644)
    assert ws.read('/tmp/x') == b'scratch'


def test_workspace_write_creates_a_file_owned_by_the_writer_with_mode_644():
    ws = _workspace()
    ws.write('new.txt', b'hello')
    entry = ws.files['/workspace/new.txt']
    assert (entry.content, entry.uid, entry.mode) == (b'hello', 1000, 0o644)


def test_workspace_write_overwrites_a_writable_file():
    ws = _workspace()
    ws.files['/workspace/a.txt'] = FakeFile(b'old', uid=1000, mode=0o644, mtime=1.0)
    ws.write('a.txt', b'new')
    assert ws.files['/workspace/a.txt'].content == b'new'
    assert ws.files['/workspace/a.txt'].mtime > 1.0


@pytest.mark.parametrize('path', ['/workspace', '/', '/etc', '/tmp', '/workspace/d'])
def test_workspace_write_onto_any_directory_raises_eisdir(path):
    ws = _workspace()
    ws.files['/workspace/d'] = FakeFile(None, uid=1000, mode=0o755)
    with pytest.raises(IsADirectoryError) as info:
        ws.write(path, b'x')
    assert info.value.errno == errno.EISDIR


def test_workspace_write_onto_a_read_only_file_raises_eacces():
    ws = _workspace()
    ws.files['/workspace/ro'] = FakeFile(b'old', uid=1000, mode=0o444)
    with pytest.raises(PermissionError) as info:
        ws.write('ro', b'new')
    assert info.value.errno == errno.EACCES
    assert ws.files['/workspace/ro'].content == b'old'


def test_workspace_write_onto_a_root_owned_file_raises_eacces_for_uid_1000():
    ws = _workspace()
    ws.files['/workspace/up'] = FakeFile(b'old', uid=0, mode=0o644)
    with pytest.raises(PermissionError):
        ws.write('up', b'new')


def test_workspace_write_with_a_missing_parent_raises_enoent():
    with pytest.raises(FileNotFoundError) as info:
        _workspace().write('nodir/x', b'x')
    assert info.value.errno == errno.ENOENT


def test_workspace_write_with_a_file_as_parent_raises_enotdir():
    ws = _workspace()
    ws.files['/workspace/f'] = FakeFile(b'', uid=1000, mode=0o644)
    with pytest.raises(NotADirectoryError) as info:
        ws.write('f/x', b'x')
    assert info.value.errno == errno.ENOTDIR


def test_workspace_write_into_a_directory_without_write_permission_raises_eacces():
    ws = _workspace()
    ws.files['/workspace/ro'] = FakeFile(None, uid=0, mode=0o555)
    with pytest.raises(PermissionError) as info:
        ws.write('ro/x', b'x')
    assert info.value.errno == errno.EACCES
    assert '/workspace/ro/x' not in ws.files


@pytest.mark.parametrize(('owner', 'mode'), [(1000, 0o600), (0, 0o700), (0, 0o600)])
def test_workspace_read_through_a_directory_without_the_search_bit_raises_eacces(owner, mode):
    ws = _workspace()
    ws.files['/workspace/closed'] = FakeFile(None, uid=owner, mode=mode)
    ws.files['/workspace/closed/f'] = FakeFile(b'x', uid=1000, mode=0o644)
    with pytest.raises(PermissionError) as info:
        ws.read('closed/f')
    assert info.value.errno == errno.EACCES


def test_workspace_write_through_a_directory_without_the_search_bit_raises_eacces():
    ws = _workspace()
    ws.files['/workspace/closed'] = FakeFile(None, uid=1000, mode=0o600)
    ws.files['/workspace/closed/f'] = FakeFile(b'old', uid=1000, mode=0o644)
    with pytest.raises(PermissionError):
        ws.write('closed/f', b'new')
    assert ws.files['/workspace/closed/f'].content == b'old'


def test_workspace_read_of_etc_passwd_needs_the_search_bit_on_etc():
    ws = _workspace()
    ws.rootfs['/etc'].mode = 0o700
    with pytest.raises(PermissionError) as info:
        ws.read('/etc/passwd')
    assert info.value.errno == errno.EACCES


def test_workspace_listdir_returns_sorted_direct_children_only():
    ws = _workspace()
    ws.files['/workspace/d'] = FakeFile(None, uid=1000, mode=0o755)
    ws.files['/workspace/d/x'] = FakeFile(b'', uid=1000, mode=0o644)
    ws.files['/workspace/d/sub'] = FakeFile(None, uid=1000, mode=0o755)
    ws.files['/workspace/d/sub/y'] = FakeFile(b'', uid=1000, mode=0o644)
    ws.files['/workspace/dd'] = FakeFile(None, uid=1000, mode=0o755)
    ws.files['/workspace/dd/z'] = FakeFile(b'', uid=1000, mode=0o644)
    assert ws.listdir('d') == ['sub', 'x']
    assert ws.listdir('.') == ['d', 'dd']


def test_workspace_listdir_of_the_guest_root_lists_etc_tmp_and_workspace():
    ws = _workspace()
    assert ws.listdir('/') == ['etc', 'tmp', 'workspace']
    assert ws.listdir('/etc') == ['passwd']


def test_workspace_listdir_of_a_missing_path_raises_enoent():
    with pytest.raises(FileNotFoundError) as info:
        _workspace().listdir('nope')
    assert info.value.errno == errno.ENOENT


def test_workspace_listdir_of_a_file_raises_enotdir():
    ws = _workspace()
    ws.files['/workspace/f'] = FakeFile(b'', uid=1000, mode=0o644)
    with pytest.raises(NotADirectoryError) as info:
        ws.listdir('f')
    assert info.value.errno == errno.ENOTDIR


def test_workspace_listdir_of_an_unreadable_directory_raises_eacces():
    ws = _workspace()
    ws.files['/workspace/closed'] = FakeFile(None, uid=0, mode=0o000)
    with pytest.raises(PermissionError) as info:
        ws.listdir('closed')
    assert info.value.errno == errno.EACCES


# FakeBackend lifecycle.


def test_files_survive_stop_and_a_new_create():
    async def go():
        backend = await _started()
        await _sh(backend, 'printf hi > /workspace/a.txt')
        await backend.stop(CHAT)
        await backend.create(CHAT, _spec())
        return await backend.get_files(CHAT, ['/workspace/a.txt'], 100)

    assert asyncio.run(go()) == {'/workspace/a.txt': b'hi'}


def test_files_are_lost_on_destroy():
    async def go():
        backend = await _started()
        await _sh(backend, 'printf hi > /workspace/a.txt')
        await backend.destroy(CHAT)
        await backend.create(CHAT, _spec())
        return await backend.get_files(CHAT, ['/workspace/a.txt'], 100), await backend.list_sandboxes()

    files, listed = asyncio.run(go())
    assert files == {}
    assert [info.chat_id for info in listed] == [CHAT]


def test_destroy_removes_the_chat_from_the_listing():
    async def go():
        backend = await _started()
        await backend.destroy(CHAT)
        return await backend.list_sandboxes()

    assert asyncio.run(go()) == []


def test_create_twice_with_the_same_image_keeps_the_running_container():
    async def go():
        backend = await _started()
        first = backend.sandboxes[CHAT].ip
        await backend.create(CHAT, _spec())
        return first, backend.sandboxes[CHAT].ip

    first, second = asyncio.run(go())
    assert first is not None
    assert second == first


def test_create_with_another_image_replaces_the_container_and_keeps_the_files():
    async def go():
        backend = await _started()
        await _sh(backend, 'printf hi > /workspace/a.txt')
        first_ip = backend.sandboxes[CHAT].ip
        await backend.create(CHAT, _spec(image='web'))
        files = await backend.get_files(CHAT, ['/workspace/a.txt'], 100)
        return backend.sandboxes[CHAT], first_ip, files

    box, first_ip, files = asyncio.run(go())
    assert box.image == 'web'
    assert box.running is True
    assert box.ip not in (None, first_ip)
    assert files == {'/workspace/a.txt': b'hi'}


def test_create_after_stop_starts_a_new_container_with_a_new_address():
    async def go():
        backend = await _started()
        first_ip = backend.sandboxes[CHAT].ip
        await backend.stop(CHAT)
        await backend.create(CHAT, _spec())
        return first_ip, backend.sandboxes[CHAT]

    first_ip, box = asyncio.run(go())
    assert box.running is True
    assert box.ip not in (None, first_ip)


def test_create_with_a_mismatched_chat_id_raises_value_error():
    async def go():
        backend = FakeBackend()
        with pytest.raises(ValueError, match=OTHER):
            await backend.create(CHAT, _spec(OTHER))
        return backend.sandboxes

    assert asyncio.run(go()) == {}


@pytest.mark.parametrize('spec', [None, 'data', {'chat_id': CHAT, 'image': 'data'}])
def test_create_with_a_spec_that_is_not_a_sandbox_spec_raises_type_error(spec):
    async def go():
        backend = FakeBackend()
        with pytest.raises(TypeError, match='SandboxSpec'):
            await backend.create(CHAT, spec)
        return backend.sandboxes

    assert asyncio.run(go()) == {}


def test_create_with_a_str_subclass_chat_id_keys_the_sandbox_by_a_plain_str():
    async def go():
        backend = FakeBackend()
        await backend.create(_StrSubclass(CHAT), _spec())
        return backend.sandboxes

    (key,) = asyncio.run(go())
    assert type(key) is str
    assert key == CHAT


def test_ready_is_none_by_default():
    assert asyncio.run(FakeBackend().ready()) is None


def test_ready_reason_makes_ready_return_it_and_create_raise_unavailable():
    async def go():
        backend = FakeBackend()
        backend.ready_reason = 'no kata runtime'
        reason = await backend.ready()
        with pytest.raises(SandboxUnavailable, match='no kata runtime'):
            await backend.create(CHAT, _spec())
        return reason, backend.sandboxes

    reason, sandboxes = asyncio.run(go())
    assert reason == 'no kata runtime'
    assert sandboxes == {}


_OPERATIONS: dict[str, Callable[[FakeBackend], object]] = {
    'exec': lambda backend: _sh(backend, 'printf hi'),
    'put_files': lambda backend: backend.put_files(CHAT, 'up', [('a', b'A', 0o444)]),
    'get_files': lambda backend: backend.get_files(CHAT, ['/workspace/a'], 10),
    'stat': lambda backend: backend.stat(CHAT, '/workspace/a'),
}


@pytest.mark.parametrize('operation', sorted(_OPERATIONS))
def test_operation_before_create_raises_not_running(operation):
    async def go():
        await _OPERATIONS[operation](FakeBackend())

    with pytest.raises(SandboxNotRunning):
        asyncio.run(go())


@pytest.mark.parametrize('operation', sorted(_OPERATIONS))
def test_operation_after_stop_raises_not_running(operation):
    async def go():
        backend = await _started()
        await backend.stop(CHAT)
        await _OPERATIONS[operation](backend)

    with pytest.raises(SandboxNotRunning):
        asyncio.run(go())


@pytest.mark.parametrize('operation', sorted(_OPERATIONS))
def test_operation_after_destroy_raises_not_running(operation):
    async def go():
        backend = await _started()
        await backend.destroy(CHAT)
        await _OPERATIONS[operation](backend)

    with pytest.raises(SandboxNotRunning):
        asyncio.run(go())


def test_not_running_error_is_a_sandbox_error():
    assert issubclass(SandboxNotRunning, sandbox_pkg.SandboxError)
    assert issubclass(SandboxUnavailable, sandbox_pkg.SandboxError)


def test_stop_and_destroy_of_an_unknown_chat_are_no_ops():
    async def go():
        backend = FakeBackend()
        await backend.stop(GHOST)
        await backend.destroy(GHOST)
        return backend.sandboxes

    assert asyncio.run(go()) == {}


def test_list_sandboxes_reports_running_and_stopped_chats():
    async def go():
        backend = FakeBackend()
        await backend.create(CHAT, _spec(CHAT))
        await backend.create(OTHER, _spec(OTHER))
        await backend.stop(OTHER)
        return sorted(await backend.list_sandboxes(), key=lambda info: info.chat_id)

    listed = asyncio.run(go())
    assert [(info.chat_id, info.running) for info in listed] == [(CHAT, True), (OTHER, False)]
    assert listed[0].ip is not None
    assert listed[1].ip is None
    assert all(isinstance(info.last_used, dt.datetime) and info.last_used.tzinfo for info in listed)


def test_list_sandboxes_reports_the_image_and_ephemeral_flag_running_and_stopped():
    async def go():
        backend = FakeBackend()
        await backend.create(CHAT, _spec(CHAT, 'web', ephemeral=True))
        await backend.create(OTHER, _spec(OTHER, 'data'))
        running = sorted(await backend.list_sandboxes(), key=lambda info: info.chat_id)
        await backend.stop(CHAT)
        await backend.stop(OTHER)
        stopped = sorted(await backend.list_sandboxes(), key=lambda info: info.chat_id)
        return running, stopped

    running, stopped = asyncio.run(go())
    assert [(info.chat_id, info.running, info.image, info.ephemeral) for info in running] == [
        (CHAT, True, 'web', True),
        (OTHER, True, 'data', False),
    ]
    # A stopped sandbox is only a volume: the image went with the container, the ephemeral flag stays.
    assert [(info.chat_id, info.running, info.image, info.ephemeral) for info in stopped] == [
        (CHAT, False, None, True),
        (OTHER, False, None, False),
    ]


def test_list_sandboxes_reports_the_new_image_after_an_image_switch():
    async def go():
        backend = await _started()
        await backend.create(CHAT, _spec(image='web'))
        return await backend.list_sandboxes()

    (info,) = asyncio.run(go())
    assert (info.image, info.ephemeral) == ('web', False)


def test_a_later_create_keeps_the_ephemeral_flag_of_the_spec_that_created_the_volume():
    async def go():
        backend = await _started()
        await backend.stop(CHAT)
        await backend.create(CHAT, _spec(ephemeral=True))
        return await backend.list_sandboxes()

    (info,) = asyncio.run(go())
    assert (info.running, info.ephemeral) == (True, False)


def test_last_used_is_set_when_create_starts_the_container():
    async def go():
        before = dt.datetime.now(dt.UTC)
        backend = await _started()
        (info,) = await backend.list_sandboxes()
        return before, info.last_used, dt.datetime.now(dt.UTC)

    before, last_used, after = asyncio.run(go())
    assert before <= last_used <= after


def test_last_used_is_not_moved_by_exec_put_get_stat_or_a_create_that_keeps_the_container():
    long_ago = dt.datetime(2000, 1, 1, tzinfo=dt.UTC)

    async def go():
        backend = await _started()
        backend.sandboxes[CHAT].last_used = long_ago
        await _sh(backend, 'printf hi > a.txt')
        await backend.put_files(CHAT, 'up', [('a', b'A', 0o444)])
        await backend.get_files(CHAT, ['/workspace/a.txt'], 100)
        await backend.stat(CHAT, '/workspace/a.txt')
        await backend.create(CHAT, _spec())
        return await backend.list_sandboxes()

    (info,) = asyncio.run(go())
    assert info.last_used == long_ago


@pytest.mark.parametrize('restart', ['after_stop', 'image_switch'])
def test_last_used_is_updated_when_a_create_starts_a_new_container(restart):
    long_ago = dt.datetime(2000, 1, 1, tzinfo=dt.UTC)
    volume_made = dt.datetime(1999, 6, 1, tzinfo=dt.UTC)

    async def go():
        backend = await _started()
        backend.sandboxes[CHAT].last_used = long_ago
        backend.sandboxes[CHAT].volume_created = volume_made
        if restart == 'after_stop':
            await backend.stop(CHAT)
            stopped = (await backend.list_sandboxes())[0].last_used
            await backend.create(CHAT, _spec())
        else:
            stopped = None
            await backend.create(CHAT, _spec(image='web'))
        return stopped, (await backend.list_sandboxes())[0].last_used

    stopped, restarted = asyncio.run(go())
    if restart == 'after_stop':
        # A stopped sandbox is only its volume, so it reports the volume's creation time, not the last start.
        assert stopped == volume_made
    assert restarted > long_ago


def test_calls_record_methods_and_arguments_in_order():
    async def go():
        backend = FakeBackend()
        spec = _spec()
        argv = wrap_command('printf hi', 5)
        await backend.create(CHAT, spec)
        await backend.put_files(CHAT, 'up', [('a', b'A', 0o444)])
        await backend.exec(CHAT, argv, 5, b'in')
        await backend.get_files(CHAT, ['/workspace/up/a'], 100)
        await backend.stat(CHAT, '/workspace/up')
        await backend.list_sandboxes()
        await backend.ready()
        await backend.stop(CHAT)
        await backend.destroy(CHAT)
        return backend.calls, spec, argv

    calls, spec, argv = asyncio.run(go())
    assert calls == [
        ('create', {'chat_id': CHAT, 'spec': spec}),
        ('put_files', {'chat_id': CHAT, 'dir': 'up', 'files': [('a', b'A', 0o444)]}),
        ('exec', {'chat_id': CHAT, 'argv': argv, 'timeout_s': 5, 'stdin': b'in'}),
        ('kill_uid_1000', {'chat_id': CHAT}),
        ('get_files', {'chat_id': CHAT, 'paths': ['/workspace/up/a'], 'max_bytes': 100}),
        ('stat', {'chat_id': CHAT, 'path': '/workspace/up'}),
        ('list_sandboxes', {}),
        ('ready', {}),
        ('stop', {'chat_id': CHAT}),
        ('destroy', {'chat_id': CHAT}),
    ]


def test_calls_record_a_call_that_raised():
    async def go():
        backend = FakeBackend()
        with pytest.raises(SandboxNotRunning):
            await _sh(backend, 'printf hi')
        return backend.calls

    calls = asyncio.run(go())
    assert [name for name, _ in calls] == ['exec']
    assert calls[0][1]['stdin'] is None


# put_files, get_files and stat.


def test_put_files_writes_root_owned_files_with_the_given_mode_in_a_root_owned_555_directory():
    async def go():
        backend = await _started()
        await backend.put_files(CHAT, 'up', [('a.txt', b'A', 0o444), ('run.sh', b'B', 0o555)])
        return backend.sandboxes[CHAT].files

    files = asyncio.run(go())
    assert (files['/workspace/up'].content, files['/workspace/up'].uid, files['/workspace/up'].mode) == (None, 0, 0o555)
    assert (files['/workspace/up/a.txt'].content, files['/workspace/up/a.txt'].uid) == (b'A', 0)
    assert files['/workspace/up/a.txt'].mode == 0o444
    assert (files['/workspace/up/run.sh'].content, files['/workspace/up/run.sh'].uid) == (b'B', 0)
    assert files['/workspace/up/run.sh'].mode == 0o555


def test_put_files_gives_the_directory_and_every_file_one_shared_mtime():
    async def go():
        backend = await _started()
        before = time.time()
        await backend.put_files(CHAT, 'up', [('a', b'A', 0o444), ('b', b'B', 0o444)])
        return before, time.time(), backend.sandboxes[CHAT].files

    before, after, files = asyncio.run(go())
    mtimes = {files[path].mtime for path in ('/workspace/up', '/workspace/up/a', '/workspace/up/b')}
    assert len(mtimes) == 1
    assert before <= mtimes.pop() <= after


def test_put_files_with_no_files_leaves_an_empty_root_owned_555_directory():
    async def go():
        backend = await _started()
        await backend.put_files(CHAT, 'up', [])
        return backend.sandboxes[CHAT].files

    files = asyncio.run(go())
    assert sorted(files) == ['/workspace', '/workspace/up']
    assert (files['/workspace/up'].uid, files['/workspace/up'].mode) == (0, 0o555)


def test_put_files_makes_an_existing_directory_root_owned_555():
    async def go():
        backend = await _started()
        backend.sandboxes[CHAT].files['/workspace/up'] = FakeFile(None, uid=1000, mode=0o755)
        await backend.put_files(CHAT, 'up', [('a', b'A', 0o444)])
        return backend.sandboxes[CHAT].files['/workspace/up']

    entry = asyncio.run(go())
    assert (entry.uid, entry.mode) == (0, 0o555)


def test_put_files_leaves_exactly_the_given_files_and_removes_the_others():
    async def go():
        backend = await _started()
        await backend.put_files(CHAT, 'up', [('a', b'old', 0o444), ('gone', b'kept?', 0o444)])
        await backend.put_files(CHAT, 'up', [('a', b'new', 0o400)])
        return backend.sandboxes[CHAT].files

    files = asyncio.run(go())
    assert sorted(files) == ['/workspace', '/workspace/up', '/workspace/up/a']
    assert (files['/workspace/up/a'].content, files['/workspace/up/a'].mode) == (b'new', 0o400)


def test_put_files_removes_files_and_directories_uid_1000_planted_in_the_directory():
    async def go():
        backend = await _started()
        await backend.put_files(CHAT, 'up', [('a', b'A', 0o444)])
        files = backend.sandboxes[CHAT].files
        files['/workspace/up/planted'] = FakeFile(b'evil', uid=1000, mode=0o755)
        files['/workspace/up/sub'] = FakeFile(None, uid=1000, mode=0o755)
        files['/workspace/up/sub/deep'] = FakeFile(b'evil', uid=1000, mode=0o755)
        await backend.put_files(CHAT, 'up', [('a', b'A2', 0o444)])
        return sorted(files)

    assert asyncio.run(go()) == ['/workspace', '/workspace/up', '/workspace/up/a']


def test_put_files_replaces_a_regular_file_that_has_the_directorys_name():
    async def go():
        backend = await _started()
        backend.sandboxes[CHAT].files['/workspace/up'] = FakeFile(b'a file', uid=1000, mode=0o644)
        await backend.put_files(CHAT, 'up', [('a', b'A', 0o444)])
        return backend.sandboxes[CHAT].files

    files = asyncio.run(go())
    assert (files['/workspace/up'].content, files['/workspace/up'].uid, files['/workspace/up'].mode) == (None, 0, 0o555)
    assert files['/workspace/up/a'].content == b'A'


def test_put_files_leaves_a_sibling_whose_name_merely_starts_with_the_directory_name():
    async def go():
        backend = await _started()
        files = backend.sandboxes[CHAT].files
        files['/workspace/upload'] = FakeFile(None, uid=1000, mode=0o755)
        files['/workspace/upload/x'] = FakeFile(b'mine', uid=1000, mode=0o644)
        files['/workspace/other.txt'] = FakeFile(b'mine', uid=1000, mode=0o644)
        await backend.put_files(CHAT, 'up', [('a', b'A', 0o444)])
        return sorted(files)

    assert asyncio.run(go()) == [
        '/workspace',
        '/workspace/other.txt',
        '/workspace/up',
        '/workspace/up/a',
        '/workspace/upload',
        '/workspace/upload/x',
    ]


_BAD_COMPONENTS = ['', '.', '..', 'a/b', '/abs', '../x', 'x/', 'a\0b', 'a' * 256, '€' * 86]


@pytest.mark.parametrize('directory', [*_BAD_COMPONENTS, '/workspace/up', '/workspace', '/etc'])
def test_put_files_with_a_dir_that_is_not_a_single_component_raises_value_error(directory):
    async def go():
        await (await _started()).put_files(CHAT, directory, [('a', b'A', 0o444)])

    with pytest.raises(ValueError, match='single path component'):
        asyncio.run(go())


@pytest.mark.parametrize('name', _BAD_COMPONENTS)
def test_put_files_with_a_name_that_is_not_a_single_component_raises_value_error(name):
    async def go():
        await (await _started()).put_files(CHAT, 'up', [(name, b'A', 0o444)])

    with pytest.raises(ValueError, match='single path component'):
        asyncio.run(go())


@pytest.mark.parametrize('component', ['a' * 255, '€' * 85, 'a b', '.hidden', '..x', 'x..'])
def test_put_files_accepts_a_dir_and_a_name_that_are_single_components(component):
    async def go():
        backend = await _started()
        await backend.put_files(CHAT, component, [(component, b'A', 0o444)])
        return backend.sandboxes[CHAT].files

    files = asyncio.run(go())
    assert files[f'/workspace/{component}/{component}'].content == b'A'


@pytest.mark.parametrize('bad', [5, None, b'up'])
def test_put_files_with_a_dir_that_is_not_a_str_raises_type_error(bad):
    async def go():
        await (await _started()).put_files(CHAT, bad, [('a', b'A', 0o444)])

    with pytest.raises(TypeError, match='str'):
        asyncio.run(go())


@pytest.mark.parametrize('bad', [5, None, b'a'])
def test_put_files_with_a_name_that_is_not_a_str_raises_type_error(bad):
    async def go():
        await (await _started()).put_files(CHAT, 'up', [(bad, b'A', 0o444)])

    with pytest.raises(TypeError, match='str'):
        asyncio.run(go())


@pytest.mark.parametrize('files', [(('a', b'A', 0o444),), None, {'a': b'A'}])
def test_put_files_with_files_that_are_not_a_list_raises_type_error(files):
    async def go():
        backend = await _started()
        with pytest.raises(TypeError, match='files must be a list'):
            await backend.put_files(CHAT, 'up', files)
        return backend.calls[-1], sorted(backend.sandboxes[CHAT].files)

    call, paths = asyncio.run(go())
    assert call == ('put_files', {'chat_id': CHAT, 'dir': 'up', 'files': files})
    assert paths == ['/workspace']


def test_put_files_with_a_content_that_is_not_bytes_raises_type_error():
    async def go():
        await (await _started()).put_files(CHAT, 'up', [('a', 'text', 0o444)])

    with pytest.raises(TypeError, match='bytes'):
        asyncio.run(go())


@pytest.mark.parametrize('mode', [292.0, True, '0o444', None])
def test_put_files_with_a_mode_that_is_not_an_int_raises_type_error(mode):
    async def go():
        await (await _started()).put_files(CHAT, 'up', [('a', b'A', mode)])

    with pytest.raises(TypeError, match='int'):
        asyncio.run(go())


def test_put_files_with_a_name_given_twice_raises_value_error():
    async def go():
        await (await _started()).put_files(CHAT, 'up', [('a', b'1', 0o444), ('b', b'2', 0o444), ('a', b'3', 0o444)])

    with pytest.raises(ValueError, match='twice'):
        asyncio.run(go())


@pytest.mark.parametrize(
    'mode',
    [0o644, 0o755, 0o777, 0o200, 0o020, 0o002, 0o1555, 0o2555, 0o4555, 0o7555, 0o7777, 0o10000, -1],
)
def test_put_files_with_a_mode_outside_0o555_raises_value_error(mode):
    async def go():
        await (await _started()).put_files(CHAT, 'up', [('a', b'A', mode)])

    with pytest.raises(ValueError, match='0o555'):
        asyncio.run(go())


@pytest.mark.parametrize('mode', [0o000, 0o004, 0o040, 0o100, 0o400, 0o444, 0o500, 0o555])
def test_put_files_accepts_a_mode_made_only_of_read_and_execute_bits(mode):
    async def go():
        backend = await _started()
        await backend.put_files(CHAT, 'up', [('a', b'A', mode)])
        return backend.sandboxes[CHAT].files['/workspace/up/a'].mode

    assert asyncio.run(go()) == mode


def test_put_files_with_one_bad_file_writes_nothing():
    async def go():
        backend = await _started()
        with pytest.raises(ValueError, match='single path component'):
            await backend.put_files(CHAT, 'up', [('good', b'A', 0o444), ('bad/name', b'B', 0o444)])
        return backend.sandboxes[CHAT].files

    assert sorted(asyncio.run(go())) == ['/workspace']


def test_put_files_with_a_bad_argument_leaves_the_existing_directory_as_it_was():
    async def go():
        backend = await _started()
        await backend.put_files(CHAT, 'up', [('good', b'A', 0o444)])
        with pytest.raises(ValueError, match='0o555'):
            await backend.put_files(CHAT, 'up', [('other', b'B', 0o644)])
        return sorted(backend.sandboxes[CHAT].files)

    assert asyncio.run(go()) == ['/workspace', '/workspace/up', '/workspace/up/good']


def test_uid_1000_cannot_overwrite_an_uploaded_file():
    async def go():
        backend = await _started()
        await backend.put_files(CHAT, 'up', [('f.txt', b'original', 0o444)])
        result = await _sh(backend, 'printf changed > /workspace/up/f.txt')
        return result, await backend.get_files(CHAT, ['/workspace/up/f.txt'], 100)

    result, files = asyncio.run(go())
    assert result.returncode == 1
    assert 'Permission denied' in result.stderr
    assert files == {'/workspace/up/f.txt': b'original'}


def test_uid_1000_cannot_create_a_file_in_an_uploads_directory():
    async def go():
        backend = await _started()
        await backend.put_files(CHAT, 'up', [('f.txt', b'original', 0o444)])
        result = await _sh(backend, 'printf x > /workspace/up/new.txt')
        return result, await backend.get_files(CHAT, ['/workspace/up/new.txt'], 100)

    result, files = asyncio.run(go())
    assert result.returncode == 1
    assert 'Permission denied' in result.stderr
    assert files == {}


def test_uid_1000_can_write_new_files_in_workspace():
    async def go():
        backend = await _started()
        await backend.put_files(CHAT, 'up', [('f.txt', b'original', 0o444)])
        written = await _sh(backend, 'printf mine > /workspace/new.txt')
        return written, await _sh(backend, 'cat /workspace/new.txt')

    written, read_back = asyncio.run(go())
    assert (written.returncode, written.stderr) == (0, '')
    assert (read_back.returncode, read_back.stdout) == (0, 'mine')


def test_uid_1000_can_read_an_uploaded_world_readable_file():
    async def go():
        backend = await _started()
        await backend.put_files(CHAT, 'up', [('f.txt', b'original', 0o444)])
        return await _sh(backend, 'cat up/f.txt')

    assert asyncio.run(go()).stdout == 'original'


def test_uid_1000_cannot_read_an_uploaded_mode_400_file_but_get_files_can():
    async def go():
        backend = await _started()
        await backend.put_files(CHAT, 'up', [('s', b'secret', 0o400)])
        return await _sh(backend, 'cat up/s'), await backend.get_files(CHAT, ['/workspace/up/s'], 100)

    result, files = asyncio.run(go())
    assert result.returncode == 1
    assert result.stderr == 'cat: up/s: Permission denied\n'
    assert files == {'/workspace/up/s': b'secret'}


def test_get_files_returns_regular_files_keyed_by_the_path_as_given():
    async def go():
        backend = await _started()
        await _sh(backend, 'printf one > a.txt')
        await _sh(backend, 'printf two > b.txt')
        return await backend.get_files(CHAT, ['/workspace/b.txt', '/workspace/a.txt'], 100)

    assert asyncio.run(go()) == {'/workspace/a.txt': b'one', '/workspace/b.txt': b'two'}


def test_get_files_omits_missing_directory_and_oversized_files():
    async def go():
        backend = await _started()
        await _sh(backend, 'printf 0123456789 > big.txt')
        await _sh(backend, 'printf ok > small.txt')
        await backend.put_files(CHAT, 'up', [])
        paths = ['/workspace/missing', '/workspace/up', '/workspace/big.txt', '/workspace/small.txt']
        return await backend.get_files(CHAT, paths, 5)

    assert asyncio.run(go()) == {'/workspace/small.txt': b'ok'}


def test_get_files_includes_a_file_of_exactly_max_bytes():
    async def go():
        backend = await _started()
        await _sh(backend, 'printf 12345 > f.txt')
        return await backend.get_files(CHAT, ['/workspace/f.txt'], 5), await backend.get_files(
            CHAT, ['/workspace/f.txt'], 4
        )

    assert asyncio.run(go()) == ({'/workspace/f.txt': b'12345'}, {})


def test_get_files_includes_an_empty_file_when_max_bytes_is_zero():
    async def go():
        backend = await _started()
        await _sh(backend, 'printf "" > e.txt')
        return await backend.get_files(CHAT, ['/workspace/e.txt'], 0)

    assert asyncio.run(go()) == {'/workspace/e.txt': b''}


_BAD_PATHS = [
    '/workspace',
    '/workspace/',
    'rel/path',
    '',
    '/',
    '/etc/passwd',
    '/tmp/x',
    '/workspace/../etc/passwd',
    '/workspace/../workspace/a',
    '/workspace/./a',
    '/workspace//a',
    '//workspace/a',
    '/workspace/a/',
    '/workspacex/a',
    '/workspace/a\0b',
]


@pytest.mark.parametrize('path', _BAD_PATHS)
def test_get_files_with_a_path_that_is_not_absolute_normalised_and_under_workspace_raises_value_error(path):
    async def go():
        backend = await _started()
        await backend.get_files(CHAT, ['/workspace/a', path], 10)

    with pytest.raises(ValueError, match='normalised'):
        asyncio.run(go())


def test_get_files_with_a_path_that_is_not_a_str_raises_type_error():
    async def go():
        await (await _started()).get_files(CHAT, ['/workspace/a', 5], 10)

    with pytest.raises(TypeError, match='str'):
        asyncio.run(go())


def test_get_files_with_a_negative_max_bytes_raises_value_error():
    async def go():
        await (await _started()).get_files(CHAT, ['/workspace/a'], -1)

    with pytest.raises(ValueError, match='negative'):
        asyncio.run(go())


@pytest.mark.parametrize('max_bytes', [True, False, 5.0, '5', None])
def test_get_files_with_a_max_bytes_that_is_not_an_int_raises_type_error(max_bytes):
    async def go():
        await (await _started()).get_files(CHAT, ['/workspace/a'], max_bytes)

    with pytest.raises(TypeError, match='max_bytes must be an int'):
        asyncio.run(go())


@pytest.mark.parametrize('paths', ['/workspace/a', ('/workspace/a',), None])
def test_get_files_with_paths_that_are_not_a_list_raises_type_error(paths):
    async def go():
        backend = await _started()
        with pytest.raises(TypeError, match='paths must be a list'):
            await backend.get_files(CHAT, paths, 10)
        return backend.calls[-1]

    assert asyncio.run(go()) == ('get_files', {'chat_id': CHAT, 'paths': paths, 'max_bytes': 10})


def test_stat_of_a_file_reports_the_owner_mode_size_and_mtime():
    async def go():
        backend = await _started()
        before = time.time()
        await _sh(backend, 'printf hello > a.txt')
        return before, time.time(), await backend.stat(CHAT, '/workspace/a.txt')

    before, after, found = asyncio.run(go())
    assert isinstance(found, FileStat)
    assert (found.path, found.kind, found.uid, found.mode, found.size) == ('/workspace/a.txt', 'file', 1000, 0o644, 5)
    assert before <= found.mtime <= after


def test_stat_of_an_uploads_directory_shows_the_root_owner_and_mode_555():
    async def go():
        backend = await _started()
        await backend.put_files(CHAT, 'up', [('a', b'A', 0o444)])
        return await backend.stat(CHAT, '/workspace/up'), await backend.stat(CHAT, '/workspace/up/a')

    directory, file = asyncio.run(go())
    assert (directory.path, directory.kind, directory.uid, directory.mode, directory.size) == (
        '/workspace/up',
        'dir',
        0,
        0o555,
        0,
    )
    assert (file.kind, file.uid, file.mode, file.size) == ('file', 0, 0o444, 1)


def test_stat_allows_the_workspace_directory_itself():
    async def go():
        return await (await _started()).stat(CHAT, '/workspace')

    found = asyncio.run(go())
    assert (found.path, found.kind, found.uid, found.mode, found.size) == ('/workspace', 'dir', 1000, 0o755, 0)


def test_stat_of_a_missing_path_returns_none():
    async def go():
        return await (await _started()).stat(CHAT, '/workspace/missing')

    assert asyncio.run(go()) is None


def test_stat_reads_the_daemons_view_not_what_uid_1000_could_read():
    async def go():
        backend = await _started()
        await backend.put_files(CHAT, 'up', [('s', b'secret', 0o400)])
        return await backend.stat(CHAT, '/workspace/up/s')

    assert asyncio.run(go()).mode == 0o400


@pytest.mark.parametrize('path', [p for p in _BAD_PATHS if p not in ('/workspace',)])
def test_stat_with_a_path_that_breaks_the_path_rules_raises_value_error(path):
    async def go():
        await (await _started()).stat(CHAT, path)

    with pytest.raises(ValueError, match='normalised'):
        asyncio.run(go())


def test_stat_with_a_path_that_is_not_a_str_raises_type_error():
    async def go():
        await (await _started()).stat(CHAT, 5)

    with pytest.raises(TypeError, match='str'):
        asyncio.run(go())


# The default interpreter.


def test_cat_with_no_arguments_echoes_stdin():
    result = _run_sh('cat', stdin=b'hello\nworld\n')
    assert (result.returncode, result.stdout, result.stderr) == (0, 'hello\nworld\n', '')


def test_cat_with_no_arguments_and_no_stdin_prints_nothing():
    result = _run_sh('cat')
    assert (result.returncode, result.stdout) == (0, '')


def test_cat_prints_a_file_written_earlier():
    async def go():
        backend = await _started()
        await _sh(backend, 'printf contents > f.txt')
        return await _sh(backend, 'cat f.txt')

    result = asyncio.run(go())
    assert (result.returncode, result.stdout) == (0, 'contents')


def test_cat_of_a_missing_file_exits_1_with_the_error_on_stderr():
    result = _run_sh('cat nope.txt')
    assert (result.returncode, result.stdout) == (1, '')
    assert result.stderr == 'cat: nope.txt: No such file or directory\n'


def test_cat_of_a_directory_exits_1_with_is_a_directory():
    result = _run_sh('cat /workspace')
    assert result.returncode == 1
    assert result.stderr == 'cat: /workspace: Is a directory\n'


def test_cat_of_several_files_prints_the_readable_ones_and_exits_1_when_one_fails():
    async def go():
        backend = await _started()
        await _sh(backend, 'printf A > a.txt')
        return await _sh(backend, 'cat a.txt missing.txt')

    result = asyncio.run(go())
    assert (result.returncode, result.stdout) == (1, 'A')
    assert result.stderr == 'cat: missing.txt: No such file or directory\n'


def test_ls_of_a_directory_lists_its_entries_sorted():
    async def go():
        backend = await _started()
        for name in ('b.txt', 'c.txt', 'a.txt'):
            await _sh(backend, f'printf x > {name}')
        return await _sh(backend, 'ls /workspace'), await _sh(backend, 'ls')

    explicit, implicit = asyncio.run(go())
    # uploads is the read-only uploads mount every sandbox has (T13).
    assert (explicit.returncode, explicit.stdout) == (0, 'a.txt\nb.txt\nc.txt\nuploads\n')
    assert implicit.stdout == 'a.txt\nb.txt\nc.txt\nuploads\n'


def test_ls_of_a_file_prints_the_path_given():
    async def go():
        backend = await _started()
        await _sh(backend, 'printf x > a.txt')
        return await _sh(backend, 'ls a.txt')

    result = asyncio.run(go())
    assert (result.returncode, result.stdout) == (0, 'a.txt\n')


def test_ls_through_a_file_as_parent_exits_2_with_not_a_directory():
    async def go():
        backend = await _started()
        await _sh(backend, 'printf x > f')
        return await _sh(backend, 'ls f/x')

    result = asyncio.run(go())
    assert (result.returncode, result.stdout) == (2, '')
    assert result.stderr == "ls: cannot access 'f/x': Not a directory\n"


def test_ls_of_a_missing_path_exits_2():
    result = _run_sh('ls nope')
    assert (result.returncode, result.stdout) == (2, '')
    assert result.stderr == "ls: cannot access 'nope': No such file or directory\n"


def test_ls_of_an_unreadable_directory_exits_2_with_permission_denied():
    async def go():
        backend = await _started()
        backend.sandboxes[CHAT].files['/workspace/closed'] = FakeFile(None, uid=0, mode=0o000)
        return await _sh(backend, 'ls closed')

    result = asyncio.run(go())
    assert result.returncode == 2
    assert result.stderr == "ls: cannot access 'closed': Permission denied\n"


@pytest.mark.parametrize(
    ('command', 'expected'),
    [
        ('printf hello', 'hello'),
        ('printf', ''),
        ("printf '%s-%s' a b", 'a-b'),
        ("printf 'x%sy'", 'xy'),
        ("printf '100%%'", '100%'),
        ("printf 'a\\nb'", 'a\nb'),
        ("printf 'a\\tb'", 'a\tb'),
        ("printf 'a\\\\b'", 'a\\b'),
        ("printf '%s\\n' 'two words'", 'two words\n'),
    ],
)
def test_printf_formats_s_percent_and_escapes(command, expected):
    result = _run_sh(command)
    assert (result.returncode, result.stdout, result.stderr) == (0, expected, '')


@pytest.mark.parametrize(
    ('command', 'expected'),
    [
        ("printf '%s\\n' a b c", 'a\nb\nc\n'),
        ("printf '%s-%s\\n' a b c", 'a-b\nc-\n'),
        ("printf '%s\\n'", '\n'),
        ('printf x a b', 'x'),
        ("printf '%%%s' a b", '%a%b'),
    ],
)
def test_printf_reuses_its_format_until_every_argument_is_consumed(command, expected):
    result = _run_sh(command)
    assert (result.returncode, result.stdout, result.stderr) == (0, expected, '')


def test_a_quoted_greater_than_sign_is_still_read_as_a_redirect():
    # A documented difference from bash, which would print `a` and ignore the two extra arguments.
    async def go():
        backend = await _started()
        result = await _sh(backend, "printf a '>' f")
        return result, await backend.get_files(CHAT, ['/workspace/f'], 100)

    result, files = asyncio.run(go())
    assert (result.returncode, result.stdout) == (0, '')
    assert files == {'/workspace/f': b'a'}


def test_sleep_within_the_limit_exits_0_after_the_simulated_duration():
    result = _run_sh('sleep 2', timeout_s=60)
    assert (result.returncode, result.timed_out, result.duration_ms) == (0, False, 2000)


def test_sleep_accepts_fractional_seconds():
    assert _run_sh('sleep 0.5').duration_ms == 500


def test_sleep_over_the_limit_exits_124_timed_out_without_sleeping():
    started = time.perf_counter()
    result = _run_sh('sleep 100', timeout_s=60)
    assert time.perf_counter() - started < 1.0
    assert (result.returncode, result.timed_out, result.duration_ms) == (124, True, 60_000)


def test_sleep_over_the_clamped_limit_times_out_at_300_seconds():
    # The caller's flow: clamp a model's value once, and give the same value to the wrapper and to exec.
    timeout_s = clamp_timeout(1000)

    async def go():
        return await (await _started()).exec(CHAT, wrap_command('sleep 400', timeout_s), timeout_s)

    result = asyncio.run(go())
    assert (result.returncode, result.timed_out, result.duration_ms) == (124, True, 300_000)


@pytest.mark.parametrize('command', ['sleep abc', 'sleep', 'sleep -1', 'sleep -0.5', 'sleep nan'])
def test_sleep_with_a_bad_argument_exits_1(command):
    result = _run_sh(command)
    assert (result.returncode, result.stdout, result.timed_out, result.duration_ms) == (1, '', False, 0)
    assert result.stderr.startswith('sleep:')


@pytest.mark.parametrize('command', ['sleep -1', 'sleep nan'])
def test_sleep_with_a_negative_or_nan_interval_says_invalid_time_interval(command):
    assert _run_sh(command).stderr == 'sleep: invalid time interval\n'


def test_an_unknown_command_exits_127_command_not_found():
    result = _run_sh('echo hi')
    assert (result.returncode, result.stdout) == (127, '')
    assert result.stderr == 'bash: line 1: echo: command not found\n'


@pytest.mark.parametrize(
    'command',
    [
        'printf a; printf b',
        'printf a;printf b',
        'printf a && printf b',
        'printf a || printf b',
        'printf a | cat',
        'printf a &',
        '(printf a)',
        'cat < f.txt',
        '',
    ],
)
def test_compound_commands_exit_127(command):
    result = _run_sh(command)
    assert (result.returncode, result.stdout) == (127, '')
    assert 'command not found' in result.stderr


@pytest.mark.parametrize('command', ["printf 'abc", 'printf "abc', 'printf \'a"b'])
def test_unbalanced_quotes_exit_127(command):
    result = _run_sh(command)
    assert (result.returncode, result.stdout) == (127, '')
    assert 'command not found' in result.stderr


@pytest.mark.parametrize(
    'argv',
    [
        ['printf', 'hi'],
        ['/bin/bash', '-lc', 'printf hi'],
        ['bash', '-lc', '--', 'printf hi'],
        ['/bin/sh', '-c', '--', 'printf hi'],
        ['/bin/bash', '-c', '--', 'printf hi'],
        ['/bin/bash', '-lc', '--', 'printf hi', 'extra'],
        ['/bin/bash', '-lc', '--'],
    ],
)
def test_a_wrapped_argv_that_does_not_run_bash_lc_with_one_command_exits_127(argv):
    async def go():
        return await (await _started()).exec(CHAT, wrap_argv(argv, 60), 60)

    result = asyncio.run(go())
    assert (result.returncode, result.stdout) == (127, '')
    assert 'command not found' in result.stderr


@pytest.mark.parametrize(
    'argv',
    [
        [],
        ['printf', 'hi'],
        ['timeout', '--kill-after=5', '60', '/bin/bash', '-lc', '--', 'printf hi'],
        [TIMEOUT, '--kill-after=9', '60', *BASH, 'printf hi'],
        [TIMEOUT, '--kill-after=5', 'abc', *BASH, 'printf hi'],
        [TIMEOUT, '--kill-after=5', '30', *BASH, 'printf hi'],
        [TIMEOUT, '--kill-after=5', '60'],
        [TIMEOUT, '--kill-after=5', '60', *BASH, 'a\0b'],
    ],
)
def test_exec_refuses_an_argv_that_is_not_wrapped_for_its_timeout(argv):
    async def go():
        await (await _started()).exec(CHAT, argv, 60)

    with pytest.raises(ValueError):
        asyncio.run(go())


def test_exec_refuses_a_timeout_that_is_not_an_int():
    async def go():
        await (await _started()).exec(CHAT, wrap_command('printf hi', 60), 60.0)

    with pytest.raises(TypeError, match='int'):
        asyncio.run(go())


@pytest.mark.parametrize('timeout_s', [0, -1, 301])
def test_exec_refuses_a_timeout_outside_1_through_300_before_running_anything(timeout_s):
    seen: list[FakeExecRequest] = []

    async def script(request: FakeExecRequest) -> FakeRun:
        seen.append(request)
        return FakeRun(0)

    async def go():
        backend = await _started(script)
        with pytest.raises(ValueError, match=r'outside 1\.\.300'):
            await backend.exec(CHAT, wrap_command('printf hi', timeout_s), timeout_s)
        return backend

    backend = asyncio.run(go())
    assert seen == []
    assert [name for name, _ in backend.calls] == ['create', 'exec']


@pytest.mark.parametrize('timeout_s', [1, 300])
def test_exec_accepts_the_bounds_of_the_timeout_range(timeout_s):
    async def go():
        return await (await _started()).exec(CHAT, wrap_command('printf hi', timeout_s), timeout_s)

    assert asyncio.run(go()).stdout == 'hi'


def test_exec_refuses_an_argv_element_that_is_not_a_str():
    async def go():
        await (await _started()).exec(CHAT, [TIMEOUT, '--kill-after=5', '60', 'printf', 5], 60)

    with pytest.raises(TypeError, match='str'):
        asyncio.run(go())


def test_exec_runs_no_script_when_the_argv_is_refused():
    seen: list[FakeExecRequest] = []

    async def script(request: FakeExecRequest) -> FakeRun:
        seen.append(request)
        return FakeRun(0)

    async def go():
        await (await _started(script)).exec(CHAT, ['printf', 'hi'], 60)

    with pytest.raises(ValueError):
        asyncio.run(go())
    assert seen == []


def test_interpret_refuses_an_argv_that_is_not_wrapped_for_the_timeout():
    request = FakeExecRequest(CHAT, ['printf', 'hi'], 60, None, _workspace())
    with pytest.raises(ValueError):
        asyncio.run(interpret(request))


def test_redirect_creates_a_file_and_prints_nothing():
    async def go():
        backend = await _started()
        result = await _sh(backend, 'printf hi > out.txt')
        return result, await backend.get_files(CHAT, ['/workspace/out.txt'], 100)

    result, files = asyncio.run(go())
    assert (result.returncode, result.stdout, result.stderr) == (0, '', '')
    assert files == {'/workspace/out.txt': b'hi'}


def test_redirect_overwrites_a_file_the_user_owns():
    async def go():
        backend = await _started()
        await _sh(backend, 'printf one > f.txt')
        await _sh(backend, 'printf two > f.txt')
        return await _sh(backend, 'cat f.txt')

    assert asyncio.run(go()).stdout == 'two'


@pytest.mark.parametrize(
    ('target', 'message'),
    [
        ('/etc/x', 'Read-only file system'),
        ('/etc/passwd', 'Read-only file system'),
        ('/workspace/nodir/x', 'No such file or directory'),
        ('/workspace/d', 'Is a directory'),
        ('/workspace', 'Is a directory'),
        ('/', 'Is a directory'),
        ('/etc', 'Is a directory'),
        ('/tmp', 'Is a directory'),
    ],
)
def test_redirect_that_cannot_be_written_exits_1_with_bashs_message(target, message):
    async def go():
        backend = await _started()
        backend.sandboxes[CHAT].files['/workspace/d'] = FakeFile(None, uid=1000, mode=0o755)
        return await _sh(backend, f'printf x > {target}')

    result = asyncio.run(go())
    assert result.returncode == 1
    assert result.stderr == f'bash: line 1: {target}: {message}\n'


# Scripted exec.


def test_scripted_exec_receives_the_argv_stdin_timeout_and_workspace():
    seen: list[FakeExecRequest] = []

    async def script(request: FakeExecRequest) -> FakeRun:
        seen.append(request)
        return FakeRun(0, stdout=request.workspace.read('a.txt'))

    async def go():
        backend = await _started(script)
        backend.sandboxes[CHAT].files['/workspace/a.txt'] = FakeFile(b'from workspace', uid=1000, mode=0o644)
        return await _sh(backend, 'anything at all', timeout_s=10, stdin=b'in')

    result = asyncio.run(go())
    (request,) = seen
    assert request.chat_id == CHAT
    assert request.argv == [TIMEOUT, '--kill-after=5', '10', '/bin/bash', '-lc', '--', 'anything at all']
    assert request.timeout_s == 10
    assert request.stdin == b'in'
    assert result.stdout == 'from workspace'


def test_scripted_exec_output_is_capped_through_stream_cap():
    async def script(request: FakeExecRequest) -> FakeRun:
        return FakeRun(3, stdout=b'x' * 100_000, stderr=b'e' * 25_000, elapsed_s=1.5)

    async def go():
        return await _sh(await _started(script), 'whatever')

    result = asyncio.run(go())
    assert result.returncode == 3
    assert result.stdout == 'x' * 10_000 + MARKER.format(n=80_000) + 'x' * 10_000
    assert result.stderr == 'e' * 10_000 + MARKER.format(n=5_000) + 'e' * 10_000
    assert result.truncated is True
    assert result.duration_ms == 1500


def test_scripted_exec_elapsed_time_feeds_the_timeout_rule():
    async def script(request: FakeExecRequest) -> FakeRun:
        return FakeRun(137, elapsed_s=65.0)

    async def go():
        return await _sh(await _started(script), 'whatever', timeout_s=60)

    assert asyncio.run(go()).timed_out is True


def test_scripted_exec_exception_reaches_the_caller_unchanged():
    async def script(request: FakeExecRequest) -> FakeRun:
        raise RuntimeError('boom')

    async def go():
        await _sh(await _started(script), 'whatever')

    with pytest.raises(RuntimeError, match='boom'):
        asyncio.run(go())


def test_scripted_exec_is_not_called_when_the_chat_is_not_running():
    seen: list[FakeExecRequest] = []

    async def script(request: FakeExecRequest) -> FakeRun:
        seen.append(request)
        return FakeRun(0)

    async def go():
        await _sh(FakeBackend(script), 'whatever')

    with pytest.raises(SandboxNotRunning):
        asyncio.run(go())
    assert seen == []


def test_scripted_exec_host_deadline_hit_marks_the_result_timed_out():
    async def script(request: FakeExecRequest) -> FakeRun:
        return FakeRun(124, elapsed_s=0.0, deadline_hit=True)

    async def go():
        return await _sh(await _started(script), 'whatever', timeout_s=60)

    assert asyncio.run(go()).timed_out is True


@pytest.mark.parametrize(('elapsed_s', 'timed_out'), [(70.0, True), (100.0, True), (69.999, False)])
def test_scripted_exec_that_ran_to_the_host_deadline_is_marked_timed_out_by_the_fake(elapsed_s, timed_out):
    # Return code 0 and no deadline_hit from the script: only the fake's own deadline (60 + 10 s) can time it out.
    async def script(request: FakeExecRequest) -> FakeRun:
        return FakeRun(0, elapsed_s=elapsed_s)

    async def go():
        return await _sh(await _started(script), 'whatever', timeout_s=60)

    assert asyncio.run(go()).timed_out is timed_out


def test_scripted_exec_with_an_early_124_is_not_timed_out():
    async def script(request: FakeExecRequest) -> FakeRun:
        return FakeRun(124, elapsed_s=0.1)

    async def go():
        return await _sh(await _started(script), 'whatever', timeout_s=60)

    assert asyncio.run(go()).timed_out is False


def test_scripted_exec_with_a_negative_elapsed_time_raises_value_error():
    async def script(request: FakeExecRequest) -> FakeRun:
        return FakeRun(0, elapsed_s=-1.0)

    async def go():
        await _sh(await _started(script), 'whatever')

    with pytest.raises(ValueError, match='elapsed_s'):
        asyncio.run(go())


# The guest root.


def test_guest_can_read_etc_passwd():
    result = _run_sh('cat /etc/passwd')
    assert (result.returncode, result.stdout, result.stderr) == (0, PASSWD.decode(), '')


def test_guest_lists_etc_and_the_root_directory():
    async def go():
        backend = await _started()
        return await _sh(backend, 'ls /etc'), await _sh(backend, 'ls /')

    etc, root = asyncio.run(go())
    assert etc.stdout == 'passwd\n'
    assert root.stdout == 'etc\ntmp\nworkspace\n'


def test_guest_cannot_write_etc_passwd_and_it_is_unchanged():
    async def go():
        backend = await _started()
        return await _sh(backend, 'printf x > /etc/passwd'), await _sh(backend, 'cat /etc/passwd')

    written, read_back = asyncio.run(go())
    assert written.returncode == 1
    assert written.stderr == 'bash: line 1: /etc/passwd: Read-only file system\n'
    assert read_back.stdout == PASSWD.decode()


def test_guest_can_write_and_read_back_a_file_in_tmp():
    async def go():
        backend = await _started()
        written = await _sh(backend, 'printf scratch > /tmp/f')
        return written, await _sh(backend, 'cat /tmp/f')

    written, read_back = asyncio.run(go())
    assert (written.returncode, written.stderr) == (0, '')
    assert read_back.stdout == 'scratch'


def test_get_files_and_stat_refuse_a_tmp_path_and_a_tmp_file_is_not_on_the_volume():
    async def go():
        backend = await _started()
        await _sh(backend, 'printf scratch > /tmp/f')
        with pytest.raises(ValueError, match='normalised'):
            await backend.get_files(CHAT, ['/tmp/f'], 100)
        with pytest.raises(ValueError, match='normalised'):
            await backend.stat(CHAT, '/tmp/f')
        return backend.sandboxes[CHAT]

    box = asyncio.run(go())
    assert box.rootfs['/tmp/f'].content == b'scratch'
    assert '/tmp/f' not in box.files


def test_tmp_is_emptied_when_the_container_is_started_again_but_workspace_is_kept():
    async def go():
        backend = await _started()
        await _sh(backend, 'printf scratch > /tmp/f')
        await _sh(backend, 'printf kept > /workspace/f')
        await backend.stop(CHAT)
        await backend.create(CHAT, _spec())
        return await _sh(backend, 'cat /tmp/f'), await _sh(backend, 'cat /workspace/f')

    tmp, workspace = asyncio.run(go())
    assert (tmp.returncode, tmp.stderr) == (1, 'cat: /tmp/f: No such file or directory\n')
    assert workspace.stdout == 'kept'


def test_tmp_is_emptied_when_a_new_image_replaces_the_container():
    async def go():
        backend = await _started()
        await _sh(backend, 'printf scratch > /tmp/f')
        await backend.create(CHAT, _spec(image='web'))
        return await _sh(backend, 'cat /tmp/f')

    assert asyncio.run(go()).returncode == 1


def test_tmp_is_kept_when_create_finds_the_same_container_running():
    async def go():
        backend = await _started()
        await _sh(backend, 'printf scratch > /tmp/f')
        await backend.create(CHAT, _spec())
        return await _sh(backend, 'cat /tmp/f')

    assert asyncio.run(go()).stdout == 'scratch'


def test_two_sandboxes_do_not_share_a_tmp():
    async def go():
        backend = await _started()
        await backend.create(OTHER, _spec(OTHER))
        await _sh(backend, 'printf scratch > /tmp/f')
        return await backend.exec(OTHER, wrap_command('cat /tmp/f', 60), 60)

    assert asyncio.run(go()).returncode == 1


def test_guest_cannot_read_through_a_directory_without_the_search_bit():
    async def go():
        backend = await _started()
        files = backend.sandboxes[CHAT].files
        files['/workspace/closed'] = FakeFile(None, uid=1000, mode=0o600)
        files['/workspace/closed/f'] = FakeFile(b'x', uid=1000, mode=0o644)
        return await _sh(backend, 'cat closed/f')

    result = asyncio.run(go())
    assert (result.returncode, result.stderr) == (1, 'cat: closed/f: Permission denied\n')


def test_guest_cannot_read_a_file_with_a_file_as_parent():
    async def go():
        backend = await _started()
        await _sh(backend, 'printf x > f')
        return await _sh(backend, 'cat f/x')

    result = asyncio.run(go())
    assert (result.returncode, result.stderr) == (1, 'cat: f/x: Not a directory\n')


# Killing UID 1000's processes, and a sandbox that died.


def _names(backend: FakeBackend) -> list[str]:
    return [name for name, _ in backend.calls]


def test_a_kill_of_uid_1000_is_recorded_after_every_exec_that_ends_normally():
    async def go():
        backend = await _started()
        await _sh(backend, 'printf hi')
        await _sh(backend, 'cat nope')
        await _sh(backend, 'sleep 100', timeout_s=5)
        return backend

    backend = asyncio.run(go())
    assert _names(backend) == ['create'] + ['exec', 'kill_uid_1000'] * 3
    assert all(args == {'chat_id': CHAT} for name, args in backend.calls if name == 'kill_uid_1000')


def test_a_kill_of_uid_1000_is_recorded_after_an_exec_whose_script_raised():
    async def script(request: FakeExecRequest) -> FakeRun:
        raise RuntimeError('boom')

    async def go():
        backend = await _started(script)
        with pytest.raises(RuntimeError, match='boom'):
            await _sh(backend, 'whatever')
        return backend

    assert _names(asyncio.run(go())) == ['create', 'exec', 'kill_uid_1000']


def test_a_kill_of_uid_1000_is_recorded_for_a_137_from_the_guests_oom_killer():
    async def script(request: FakeExecRequest) -> FakeRun:
        return FakeRun(137, elapsed_s=3.0)

    async def go():
        backend = await _started(script)
        return await _sh(backend, 'whatever'), backend

    result, backend = asyncio.run(go())
    assert (result.returncode, result.timed_out) == (137, False)
    assert _names(backend) == ['create', 'exec', 'kill_uid_1000']


def test_no_kill_is_recorded_when_no_exec_could_run():
    async def go():
        backend = FakeBackend()
        with pytest.raises(SandboxNotRunning):
            await _sh(backend, 'printf hi')
        started = await _started()
        with pytest.raises(ValueError):
            await started.exec(CHAT, ['printf', 'hi'], 60)
        return backend, started

    backend, started = asyncio.run(go())
    assert _names(backend) == ['exec']
    assert _names(started) == ['create', 'exec']


@pytest.mark.parametrize('returncode', [0, 1, 124, 137])
def test_no_kill_is_recorded_when_the_sandbox_died_during_the_command(returncode):
    async def script(request: FakeExecRequest) -> FakeRun:
        backend.sandboxes[CHAT].running = False
        return FakeRun(returncode)

    backend = FakeBackend(script)

    async def go():
        await backend.create(CHAT, _spec())
        with pytest.raises(SandboxNotRunning):
            await _sh(backend, 'whatever')

    asyncio.run(go())
    assert _names(backend) == ['create', 'exec']


@pytest.mark.parametrize('returncode', [0, 1, 124, 137])
def test_any_result_from_a_sandbox_that_stopped_during_the_command_raises_not_running(returncode):
    async def script(request: FakeExecRequest) -> FakeRun:
        backend.sandboxes[CHAT].running = False
        return FakeRun(returncode, stdout=b'partial', stderr=b'oops', elapsed_s=2.0)

    backend = FakeBackend(script)

    async def go():
        await backend.create(CHAT, _spec())
        await _sh(backend, 'whatever')

    with pytest.raises(SandboxNotRunning, match='stopped during the command'):
        asyncio.run(go())


@pytest.mark.parametrize('returncode', [0, 1, 137])
def test_any_result_from_a_sandbox_that_was_destroyed_during_the_command_raises_not_running(returncode):
    async def script(request: FakeExecRequest) -> FakeRun:
        del backend.sandboxes[CHAT]
        return FakeRun(returncode)

    backend = FakeBackend(script)

    async def go():
        await backend.create(CHAT, _spec())
        await _sh(backend, 'whatever')

    with pytest.raises(SandboxNotRunning, match='stopped during the command'):
        asyncio.run(go())
    assert _names(backend) == ['create', 'exec']


# Chat ids.


_ID_OPERATIONS: dict[str, Callable[[FakeBackend, str], object]] = {
    'create': lambda backend, chat_id: backend.create(chat_id, _spec()),
    'exec': lambda backend, chat_id: backend.exec(chat_id, wrap_command('printf hi', 60), 60),
    'put_files': lambda backend, chat_id: backend.put_files(chat_id, 'up', []),
    'get_files': lambda backend, chat_id: backend.get_files(chat_id, ['/workspace/a'], 10),
    'stat': lambda backend, chat_id: backend.stat(chat_id, '/workspace/a'),
    'stop': lambda backend, chat_id: backend.stop(chat_id),
    'destroy': lambda backend, chat_id: backend.destroy(chat_id),
}


@pytest.mark.parametrize('operation', sorted(_ID_OPERATIONS))
@pytest.mark.parametrize('bad', ['c1', '', UPPER, '../etc'])
def test_every_backend_method_refuses_a_chat_id_that_is_not_a_canonical_uuid(operation, bad):
    async def go():
        backend = await _started()
        await _ID_OPERATIONS[operation](backend, bad)

    with pytest.raises(ValueError, match='canonical lowercase UUID'):
        asyncio.run(go())
