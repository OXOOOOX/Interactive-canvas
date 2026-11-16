#!/usr/bin/env bash
# Transfer and server-build an exact trusted-main Interactive-canvas snapshot.
set -Eeuo pipefail
umask 077

[[ "${GITHUB_REF:-}" == refs/heads/main && "${GITHUB_EVENT_NAME:-}" != pull_request ]]
[[ "${GITHUB_REPOSITORY:-}" == OXOOOOX/Interactive-canvas ]]
[[ "${GITHUB_SHA:-}" =~ ^[0-9a-f]{40}$ ]]
[[ "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ && "${GITHUB_RUN_ATTEMPT:-}" =~ ^[0-9]+$ ]]
[[ "${CANVAS_ACTIVATE_RELEASE:-false}" == true || "${CANVAS_ACTIVATE_RELEASE:-false}" == false ]]
[[ -n "${CANVAS_SSH_PRIVATE_KEY:-}" && -n "${CANVAS_SSH_KNOWN_HOSTS:-}" ]]
[[ "${CANVAS_DEPLOY_HOST:-}" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]]
[[ "${CANVAS_DEPLOY_USER:-}" =~ ^[a-z_][a-z0-9_-]*$ ]]

port=${CANVAS_DEPLOY_PORT:-22}
[[ "$port" =~ ^[0-9]{1,5}$ ]] && ((10#$port >= 1 && 10#$port <= 65535))

latest=$(gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/main" --jq .object.sha)
[[ "$latest" == "$GITHUB_SHA" ]] || {
  echo 'Skipping an obsolete Interactive-canvas source snapshot.'
  exit 0
}

server_root=/opt/canvas
transport_root=$(realpath -m -- "${RUNNER_TEMP:-${TMPDIR:-/tmp}}")
transport=$(mktemp -d "$transport_root/canvas-source.XXXXXX")
cleanup() {
  if [[ "$transport" == "$transport_root"/canvas-source.* && -d "$transport" ]]; then
    rm -rf -- "$transport"
  fi
}
trap cleanup EXIT

printf '%s\n' "$CANVAS_SSH_PRIVATE_KEY" | tr -d '\r' >"$transport/key"
printf '%s\n' "$CANVAS_SSH_KNOWN_HOSTS" >"$transport/known_hosts"
chmod 600 "$transport/key" "$transport/known_hosts"
unset CANVAS_SSH_PRIVATE_KEY CANVAS_SSH_KNOWN_HOSTS

ssh_options=(
  -i "$transport/key"
  -p "$port"
  -o BatchMode=yes
  -o IdentitiesOnly=yes
  -o StrictHostKeyChecking=yes
  -o "UserKnownHostsFile=$transport/known_hosts"
  -o ConnectTimeout=20
  -o ServerAliveInterval=15
  -o ServerAliveCountMax=6
)
target="$CANVAS_DEPLOY_USER@$CANVAS_DEPLOY_HOST"
remote="$server_root/releases/$GITHUB_SHA"
stage="$remote/source-stage-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"

python3 deploy/source-snapshot.py create "$GITHUB_SHA" "$transport/snapshot"

ssh "${ssh_options[@]}" "$target" \
  "sudo -n test -f '$server_root/shared/deploy-ready' && \
   sudo -n test -f '$server_root/shared/runtime-image.json' && \
   mkdir -p '$remote' && test ! -e '$stage' && mkdir '$stage'"

base=$(ssh "${ssh_options[@]}" "$target" \
  "if test -d '$server_root/current/source'; then
     realpath '$server_root/current/source'
   elif test -d '$server_root/source-seed'; then
     printf '%s\\n' '$server_root/source-seed'
   fi")
if [[ -n "$base" ]]; then
  [[ "$base" =~ ^$server_root/releases/[0-9a-f]{40}/source$ || "$base" == "$server_root/source-seed" ]]
  link_dest=(--link-dest="$base")
else
  link_dest=()
fi

# A fresh destination plus --delete ensures removed tracked resources do not
# survive from an older release. Never use --inplace with a link-dest tree.
printf -v ssh_command '%q ' ssh "${ssh_options[@]}"
rsync --recursive --times --perms --checksum --compress --stats --timeout=180 \
  --delete --partial-dir=.rsync-partial "${link_dest[@]}" -e "$ssh_command" \
  "$transport/snapshot/source/" "$target:$stage/"
rsync --checksum --timeout=60 -e "$ssh_command" \
  "$transport/snapshot/source-manifest.json" \
  "$target:$remote/source-manifest-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT.json"
manifest="$remote/source-manifest-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT.json"

ssh "${ssh_options[@]}" "$target" \
  "python3 '$stage/deploy/source-snapshot.py' verify '$GITHUB_SHA' '$stage' '$manifest' &&
   if test -e '$remote/source'; then
     cmp '$manifest' '$remote/source-manifest.json' &&
     python3 '$remote/source/deploy/source-snapshot.py' verify '$GITHUB_SHA' '$remote/source' '$remote/source-manifest.json' &&
     rm -rf -- '$stage' && rm -- '$manifest'
   else
     mv '$stage' '$remote/source' && mv '$manifest' '$remote/source-manifest.json'
   fi"

ssh "${ssh_options[@]}" "$target" \
  "sudo -n bash '$remote/source/deploy/build-on-server.sh' '$remote'" </dev/null

latest=$(gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/main" --jq .object.sha)
[[ "$latest" == "$GITHUB_SHA" ]] || {
  echo 'Built and tested, but main advanced; leaving Interactive-canvas production unchanged.'
  exit 0
}

if [[ "$CANVAS_ACTIVATE_RELEASE" == true ]]; then
  ssh "${ssh_options[@]}" "$target" \
    "sudo -n systemd-run --collect --wait --unit 'canvas-release-$GITHUB_SHA-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT' \
      --property 'StandardOutput=append:$remote/activation.log' \
      --property 'StandardError=append:$remote/activation.log' \
      /usr/bin/bash '$remote/deploy.sh' '$remote'" </dev/null
else
  echo 'Interactive-canvas source transfer, server build and tests passed. Production activation was not requested.'
fi
