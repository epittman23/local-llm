"""The sandbox network and mirror as Compose declares them (infra/docker-compose.yml), against the backend constants.

Always run: nothing starts. A sandbox reaches the mirror by a fixed address,
because container names do not resolve inside a Kata guest (Q9), so the
subnet, the range Docker hands sandboxes addresses from, and the mirror's
address are written twice: in `sandbox/kata.py` and in the Compose file. They
must agree, the network must have no route out, and the mirror must stay as
fenced as the Compose comment says. The images' pip environment and the
Makefile's service lists are checked against the same file.

Run from apps/server (any LLLM_SECRET_KEY of 32 characters or more):

    LLLM_SECRET_KEY=... python -m pytest tests/test_sandbox_compose.py
"""

import ipaddress
import re
from pathlib import Path

import pytest
import yaml

from local_llm.sandbox import kata

REPO = Path(__file__).resolve().parents[3]
INFRA = REPO / 'infra'


@pytest.fixture(scope='module')
def compose() -> dict:
    return yaml.safe_load((INFRA / 'docker-compose.yml').read_text())


@pytest.fixture(scope='module')
def mirror(compose: dict) -> dict:
    return compose['services']['sandbox-mirror']


def test_the_network_is_internal_and_named_as_the_backend_expects(compose):
    assert f'{compose["name"]}_sandbox' == kata.SANDBOX_NETWORK
    assert compose['networks']['sandbox']['internal'] is True
    # No address on the host's side of the bridge: it would expose host listeners on 0.0.0.0.
    assert compose['networks']['sandbox']['driver_opts'] == {
        'com.docker.network.bridge.inhibit_ipv4': 'true',
        'com.docker.network.bridge.name': 'lllm-sandbox',
    }


def test_the_subnet_and_ip_range_agree_with_the_backend(compose):
    (config,) = compose['networks']['sandbox']['ipam']['config']
    assert config['subnet'] == kata.SANDBOX_SUBNET
    assert config['ip_range'] == kata.SANDBOX_IP_RANGE
    assert 'gateway' not in config


def test_the_mirror_has_the_fixed_address_the_backend_passes_as_a_host(mirror):
    assert mirror['networks'] == {'sandbox': {'ipv4_address': kata.SANDBOX_MIRROR_ADDRESS}}


def test_the_mirror_address_is_in_the_subnet_and_outside_the_sandbox_range():
    address = ipaddress.ip_address(kata.SANDBOX_MIRROR_ADDRESS)
    assert address in ipaddress.ip_network(kata.SANDBOX_SUBNET)
    assert address not in ipaddress.ip_network(kata.SANDBOX_IP_RANGE)


def test_the_sandboxes_get_the_mirror_as_the_extra_host():
    options = kata.container_options(
        '11111111-1111-4111-8111-111111111111',
        'data',
        ephemeral=False,
        scope='0' * 16,
        uploads=Path('/x/11111111-1111-4111-8111-111111111111'),
    )
    assert options['extra_hosts'] == {'sandbox-mirror': kata.SANDBOX_MIRROR_ADDRESS}
    assert options['network'] == kata.SANDBOX_NETWORK


def test_the_mirror_is_not_reachable_from_outside_and_reaches_nothing(mirror):
    assert 'ports' not in mirror
    assert list(mirror['networks']) == ['sandbox']


def test_the_mirror_is_fenced(mirror):
    assert mirror['read_only'] is True
    assert mirror['cap_drop'] == ['ALL']
    assert 'cap_add' not in mirror
    assert 'no-new-privileges:true' in mirror['security_opt']
    assert mirror['user'] == '101:101'
    assert mirror['mem_limit'] and mirror['pids_limit'] <= 64
    assert 'privileged' not in mirror


def test_the_mirror_serves_the_wheelhouse_read_only_and_nothing_writable(mirror):
    html = [v for v in mirror['volumes'] if v.endswith(':/usr/share/nginx/html:ro')]
    assert len(html) == 1 and 'wheelhouse' in html[0]
    assert all(v.endswith(':ro') for v in mirror['volumes'])
    assert [t.split(':')[0] for t in mirror['tmpfs']] == ['/tmp']


def test_the_mirror_log_is_capped(mirror):
    options = mirror['logging']['options']
    assert options['max-size'] and options['max-file']


def test_the_mirror_image_is_pinned_by_digest(mirror):
    assert re.fullmatch(r'nginx:\d+\.\d+\.\d+-alpine@sha256:[0-9a-f]{64}', mirror['image'])


def test_the_mirror_listens_where_the_images_look():
    port = re.search(r'^\s*listen (\d+);', (INFRA / 'sandbox/mirror/nginx.conf').read_text(), re.M)
    assert port is not None
    dockerfile = (INFRA / 'sandbox/Dockerfile.data').read_text()
    assert f'PIP_FIND_LINKS=http://sandbox-mirror:{port.group(1)}/' in dockerfile
    for setting in ('PIP_NO_INDEX=1', 'PIP_ONLY_BINARY=:all:', 'PIP_USER=1', 'PYTHONUSERBASE=/workspace/.local'):
        assert setting in dockerfile
    assert 'PIP_TRUSTED_HOST=sandbox-mirror' in dockerfile


def test_the_mirror_serves_files_only_and_proxies_nothing():
    conf = '\n'.join(
        line
        for line in (INFRA / 'sandbox/mirror/nginx.conf').read_text().splitlines()
        if not line.lstrip().startswith('#')
    )
    assert 'autoindex on;' in conf
    assert 'limit_except GET HEAD' in conf
    for directive in ('limit_conn per_sandbox', 'client_header_timeout', 'max_ranges 1;', 'disable_symlinks on;'):
        assert directive in conf
    for directive in ('proxy_pass', 'fastcgi_pass', 'uwsgi_pass', 'scgi_pass', 'resolver', 'upstream'):
        assert directive not in conf


def test_every_lock_entry_is_hashed_and_the_allowlist_is_locked():
    lock = (INFRA / 'sandbox/requirements.lock').read_text()
    entries = re.findall(r'^([A-Za-z0-9._-]+)==\S+ \\\n((?:\s+--hash=sha256:[0-9a-f]{64}(?: \\)?\n)+)', lock, re.M)
    assert entries
    pinned = {name.lower().replace('_', '-') for name, _ in entries}
    assert len(re.findall(r'^[A-Za-z0-9._-]+==', lock, re.M)) == len(entries)
    allowlist = [
        line.strip().lower()
        for line in (INFRA / 'sandbox/allowlist.in').read_text().splitlines()
        if line.strip() and not line.startswith('#')
    ]
    assert set(allowlist) <= pinned


def test_make_backend_starts_the_mirror_and_wheelhouse_is_a_target():
    makefile = (REPO / 'Makefile').read_text()
    assert 'for svc in postgres redis searxng sandbox-mirror; do' in makefile
    assert 'up -d postgres redis searxng sandbox-mirror;' in makefile
    phony = next(line for line in makefile.splitlines() if line.startswith('.PHONY:'))
    assert 'wheelhouse' in phony.split()
    assert 'jupyter' not in makefile.lower()
    assert re.search(r'^wheelhouse:', makefile, re.M)


def test_the_compose_file_has_no_jupyter_service_network_or_volume(compose):
    assert 'jupyter' not in compose['services']
    assert 'jupyter' not in (compose.get('networks') or {})
    assert 'jupyter-work' not in (compose.get('volumes') or {})
    assert 'jupyter' not in (INFRA / 'docker-compose.yml').read_text().lower()
