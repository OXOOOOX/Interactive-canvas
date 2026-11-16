#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
[[ $# == 1 && $(id -u) == 0 ]]
release=$(realpath -e -- "$1")
[[ "$release" =~ ^/opt/canvas/releases/([0-9a-f]{40})$ ]]
revision=${BASH_REMATCH[1]}
source_dir="$release/source"
[[ -d "$source_dir" && ! -L "$source_dir" ]]
exec 9>/var/lock/site-build.lock
flock -w 3600 9
# Existing RDB releases use this lock; cooperate without changing that project.
if [[ -d /opt/rdb/shared ]]; then
  exec 7>/opt/rdb/shared/build.lock
  flock -w 3600 7
fi
exec 8>/opt/canvas/shared/build.lock
flock -w 3600 8
python3 "$source_dir/deploy/source-snapshot.py" verify "$revision" "$source_dir" "$release/source-manifest.json"
manifest_hash=$(sha256sum "$release/source-manifest.json" | cut -d ' ' -f 1)
runtime=$(python3 -c 'import json; print(json.load(open("/opt/canvas/shared/runtime-image.json"))["image"])')
runtime_id=$(python3 -c 'import json; print(json.load(open("/opt/canvas/shared/runtime-image.json"))["image_id"])')
[[ "$runtime" =~ ^canvas-runtime-base:[a-zA-Z0-9._-]+$ && "$runtime_id" =~ ^sha256:[0-9a-f]{64}$ ]]
[[ "$(docker image inspect "$runtime" --format '{{.Id}}')" == "$runtime_id" ]]
python3 - "$source_dir/Dockerfile" <<'PY'
import hashlib,json,pathlib,sys
expected=json.load(open('/opt/canvas/shared/runtime-image.json'))['source_dockerfile_sha256']
assert hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest()==expected, 'Runtime recipe changed; refresh the pinned base first.'
PY
receipt="$release/build-receipt.json"
if existing=$(docker image inspect "canvas:$revision" --format '{{.Id}}' 2>/dev/null); then
  python3 - "$receipt" "$existing" "$manifest_hash" "$runtime_id" <<'PY'
import json,sys
r=json.load(open(sys.argv[1]))
assert r=={'image_id':sys.argv[2],'manifest_sha256':sys.argv[3],'runtime_id':sys.argv[4],'tests_passed':True}
PY
else
  [[ $(df -B1 --output=avail /opt/canvas | tail -1) -gt 5368709120 ]]
  [[ $(awk '/MemAvailable:/ {print $2}' /proc/meminfo) -gt 1228800 ]]
  docker buildx build --help | grep -q -- --resource
  docker buildx build --load --pull=false \
    --resource memory=1024m --resource memory-swap=1536m \
    --resource cpu-quota=100000 --resource cpu-period=100000 \
    --build-arg "CANVAS_RUNTIME_IMAGE=$runtime" \
    --label "org.opencontainers.image.revision=$revision" \
    --label org.opencontainers.image.source=https://github.com/OXOOOOX/Interactive-canvas \
    --file "$source_dir/deploy/Dockerfile.server" --tag "canvas-build:$revision" "$source_dir" </dev/null
  [[ "$(docker image inspect "canvas-build:$revision" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')" == "$revision" ]]
  image_id=$(docker image inspect "canvas-build:$revision" --format '{{.Id}}')
  python3 - "$receipt" "$image_id" "$manifest_hash" "$runtime_id" <<'PY'
import json,os,pathlib,sys
p=pathlib.Path(sys.argv[1]);tmp=p.with_suffix('.tmp')
tmp.write_text(json.dumps({'image_id':sys.argv[2],'manifest_sha256':sys.argv[3],'runtime_id':sys.argv[4],'tests_passed':True})+'\n')
tmp.chmod(0o600);os.replace(tmp,p)
PY
  docker tag "canvas-build:$revision" "canvas:$revision"
fi
for file in compose.yaml deploy.sh release.py; do
  install -m 644 "$source_dir/deploy/$file" "$release/$file"
done
printf 'Verified server build ready: %s\n' "$revision"
