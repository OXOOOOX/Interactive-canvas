#!/usr/bin/env bash
set -Eeuo pipefail
[[ $# == 1 && $(id -u) == 0 ]]
release=$(realpath -e -- "$1")
[[ "$release" =~ ^/opt/canvas/releases/[0-9a-f]{40}$ ]]
exec python3 "$release/release.py" "$release"
