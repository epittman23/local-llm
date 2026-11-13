#!/usr/bin/env bash
# TeX Live 2025, from the final (frozen) 2025 archive, so a rebuild installs
# byte-identical packages: the live tlnet repository moves on every day, and
# 2026's is not frozen yet. install-tl is checked against its published SHA-512.
set -euo pipefail

TL_REPO=https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/2025/tlnet-final
INSTALLER_SHA512=a307d7d11bcbd1f054ad0b0d476f7f12bc1a40d07445020edef8713b44453831d18a2f1722c3d2b0ea2e4fe6c06183a79d1c4049495113f412a9f5a570a8614d

tmp="$(mktemp -d)"
curl -fsSL -o "$tmp/install-tl-unx.tar.gz" "$TL_REPO/install-tl-unx.tar.gz"
echo "${INSTALLER_SHA512}  $tmp/install-tl-unx.tar.gz" | sha512sum -c -
tar -xzf "$tmp/install-tl-unx.tar.gz" -C "$tmp"
perl "$tmp"/install-tl-*/install-tl --profile=/tmp/sandbox/texlive.profile \
    --repository "$TL_REPO" --no-interaction
rm -rf "$tmp"

bindir=/opt/texlive/2025/bin/x86_64-linux
"$bindir/tlmgr" option repository "$TL_REPO"
"$bindir/tlmgr" install latexmk biber
