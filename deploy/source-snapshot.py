#!/usr/bin/env python3
"""Create and verify a regular-file-only snapshot of an exact Git commit.

The snapshot contains every tracked regular file.  The repository's
``.dockerignore`` decides which files enter the image; this tool only keeps
untracked files, symlinks, submodules and obvious secrets out of the server
transfer.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
from typing import Dict, Iterable, List, Tuple


COMMIT_RE = re.compile(r"[0-9a-f]{40}\Z")
SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")
MAX_FILE_BYTES = 1024 ** 3
MANIFEST_FORMAT = 1
REQUIRED_FILES = {
    "Dockerfile",
    "package.json",
    "package-lock.json",
    "server/index.js",
    "vite.config.js",
}


def revision(value: str) -> str:
    if not COMMIT_RE.fullmatch(value):
        raise ValueError("An exact 40-character Git commit is required")
    return value


def safe_path(name: str) -> bool:
    path = PurePosixPath(name)
    if (
        not path.parts
        or path.is_absolute()
        or str(path) != name
        or ".." in path.parts
        or "\\" in name
        or any(ord(char) < 32 for char in name)
    ):
        return False
    return True


def secret_path(name: str) -> bool:
    """Reject deploy-time secrets while permitting .env.example."""

    path = PurePosixPath(name)
    parts = [part.casefold() for part in path.parts]
    basename = parts[-1] if parts else ""
    if any(part == ".ssh" for part in parts):
        return True
    if name.casefold() == "public/local.config.js":
        return True
    if basename in {
        ".env",
        ".env.local",
        "runtime.env",
        "proxy.env",
        "id_rsa",
        "id_ed25519",
        "id_ecdsa",
        "authorized_keys",
        "credentials.json",
        "auth.json",
    }:
        return True
    if basename.startswith(".env.") and basename != ".env.example":
        return True
    return basename.endswith((".pem", ".key", ".p12", ".pfx"))


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def git_tree(commit: str) -> List[Tuple[str, bytes, bytes, bytes]]:
    """Return (path, mode, kind, object id) entries from the exact commit."""

    listing = subprocess.check_output(
        ["git", "ls-tree", "--full-tree", "-r", "-z", commit]
    )
    entries = []
    for raw in filter(None, listing.split(b"\0")):
        try:
            attributes, encoded = raw.split(b"\t", 1)
            mode, kind, object_id = attributes.split()
            name = encoded.decode("utf-8")
        except (UnicodeDecodeError, ValueError) as exc:
            raise ValueError("Invalid Git tree entry") from exc
        if not safe_path(name):
            raise ValueError(f"Unsafe Git path: {name!r}")
        if secret_path(name):
            raise ValueError(f"Secret-looking Git path is not deployable: {name}")
        if kind != b"blob" or mode not in (b"100644", b"100755"):
            raise ValueError(f"Snapshot requires regular files only: {name}")
        if len(object_id) != 40 or not re.fullmatch(rb"[0-9a-f]{40}", object_id):
            raise ValueError(f"Invalid Git object id for {name}")
        entries.append((name, mode, kind, object_id))
    if not entries:
        raise ValueError("The requested Git commit contains no deployable files")
    folded = [name.casefold() for name, _, _, _ in entries]
    if len(set(folded)) != len(folded):
        raise ValueError("Git tree contains paths that collide case-insensitively")
    return entries


def manifest_entry(path: Path, relative: str) -> dict:
    return {
        "path": relative,
        "bytes": path.stat().st_size,
        "sha256": digest(path),
    }


def expected_directories(files: Iterable[str]) -> set[str]:
    directories: set[str] = set()
    for name in files:
        path = PurePosixPath(name)
        for index in range(1, len(path.parts)):
            directories.add("/".join(path.parts[:index]))
    return directories


def write_manifest(path: Path, manifest: dict) -> None:
    path.write_text(
        json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
        encoding="utf-8",
    )


def create(commit: str, destination: str) -> None:
    revision(commit)
    entries = git_tree(commit)
    names = {name for name, _, _, _ in entries}
    if not REQUIRED_FILES.issubset(names):
        missing = ", ".join(sorted(REQUIRED_FILES - names))
        raise ValueError(f"Required build files are missing: {missing}")
    destination_path = Path(destination).resolve()
    if destination_path.exists():
        raise ValueError("Snapshot destination must be new")
    destination_path.mkdir(parents=True, mode=0o700)
    source = destination_path / "source"
    source.mkdir(mode=0o700)

    objects = {name: (mode, object_id) for name, mode, _, object_id in entries}
    process = subprocess.Popen(
        ["git", "cat-file", "--batch"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    files: List[dict] = []
    try:
        assert process.stdin is not None and process.stdout is not None
        for name in sorted(objects):
            mode, object_id = objects[name]
            process.stdin.write(object_id + b"\n")
            process.stdin.flush()
            header = process.stdout.readline().split()
            if len(header) != 3:
                raise ValueError("Invalid Git object framing")
            returned_id, kind, size = header
            try:
                remaining = int(size)
            except ValueError as exc:
                raise ValueError("Invalid Git object size") from exc
            if (
                returned_id != object_id
                or kind != b"blob"
                or not 0 <= remaining <= MAX_FILE_BYTES
            ):
                raise ValueError(f"Unexpected Git object for {name}")
            target = source.joinpath(*PurePosixPath(name).parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("xb") as outgoing:
                while remaining:
                    block = process.stdout.read(min(remaining, 1024 * 1024))
                    if not block:
                        raise ValueError(f"Incomplete Git object for {name}")
                    outgoing.write(block)
                    remaining -= len(block)
            if process.stdout.read(1) != b"\n":
                raise ValueError("Invalid Git object framing")
            target.chmod(0o755 if mode == b"100755" else 0o644)
            os.utime(target, (0, 0))
            files.append(manifest_entry(target, name))
        process.stdin.close()
        stderr = process.stderr.read().decode("utf-8", "replace")
        if process.wait() != 0:
            raise ValueError(f"Git object read failed: {stderr.strip()}")
        if {item["path"] for item in files} != set(objects):
            raise ValueError("Incomplete Git snapshot")
    finally:
        if process.stdin is not None and not process.stdin.closed:
            process.stdin.close()
        if process.poll() is None:
            process.kill()
            process.wait()
        if process.stdout is not None:
            process.stdout.close()
        if process.stderr is not None:
            process.stderr.close()

    for folder, dirs, _ in os.walk(source):
        for name in dirs:
            directory = Path(folder, name)
            if directory.is_symlink():
                raise ValueError("Symlink directory in snapshot")
            directory.chmod(0o755)
            os.utime(directory, (0, 0))
    manifest = {
        "format": MANIFEST_FORMAT,
        "revision": commit,
        "files": sorted(files, key=lambda item: item["path"]),
    }
    manifest_path = destination_path / "source-manifest.json"
    write_manifest(manifest_path, manifest)
    verify(commit, source, manifest_path)


def parse_manifest(manifest_path: Path, commit: str) -> Dict[str, dict]:
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError("Cannot read source manifest") from exc
    if not isinstance(manifest, dict):
        raise ValueError("Invalid source manifest")
    if manifest.get("format") != MANIFEST_FORMAT or manifest.get("revision") != commit:
        raise ValueError("Wrong snapshot format or revision")
    raw_files = manifest.get("files")
    if not isinstance(raw_files, list) or not raw_files:
        raise ValueError("Source manifest has no files")
    expected: Dict[str, dict] = {}
    folded = set()
    for item in raw_files:
        if not isinstance(item, dict):
            raise ValueError("Invalid snapshot entry")
        name = item.get("path")
        if (
            not isinstance(name, str)
            or not safe_path(name)
            or secret_path(name)
            or name in expected
            or name.casefold() in folded
            or not isinstance(item.get("bytes"), int)
            or isinstance(item.get("bytes"), bool)
            or not 0 <= item["bytes"] <= MAX_FILE_BYTES
            or not isinstance(item.get("sha256"), str)
            or not SHA256_RE.fullmatch(item["sha256"])
        ):
            raise ValueError("Invalid snapshot entry")
        expected[name] = item
        folded.add(name.casefold())
    if not REQUIRED_FILES.issubset(expected):
        missing = ", ".join(sorted(REQUIRED_FILES - set(expected)))
        raise ValueError(f"Required build files are missing: {missing}")
    return expected


def verify(commit: str, source: Path, manifest_path: Path) -> None:
    revision(commit)
    source = Path(source)
    if source.is_symlink() or not source.is_dir():
        raise ValueError("Source root must be a real directory")
    expected = parse_manifest(Path(manifest_path), commit)
    actual = set()
    actual_dirs = set()
    for folder, dirs, files in os.walk(source, followlinks=False):
        folder_path = Path(folder)
        for name in dirs:
            path = folder_path / name
            if path.is_symlink():
                raise ValueError("Symlink directory in snapshot")
            actual_dirs.add(path.relative_to(source).as_posix())
        for name in files:
            path = folder_path / name
            relative = path.relative_to(source).as_posix()
            info = path.lstat()
            if not stat.S_ISREG(info.st_mode) or relative not in expected:
                raise ValueError(f"Unexpected source file: {relative}")
            item = expected[relative]
            if info.st_size != item["bytes"] or digest(path) != item["sha256"]:
                raise ValueError(f"Source content differs: {relative}")
            actual.add(relative)
    if actual != set(expected):
        raise ValueError("Source file set does not match manifest")
    if actual_dirs != expected_directories(expected):
        raise ValueError("Source directory set does not match manifest")
    print(
        f"Verified {len(actual)} source files "
        f"({sum(item['bytes'] for item in expected.values())} bytes) for {commit}."
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=["create", "verify"])
    parser.add_argument("revision")
    parser.add_argument("path")
    parser.add_argument("manifest", nargs="?")
    args = parser.parse_args()
    if args.operation == "create":
        create(args.revision, args.path)
    else:
        if args.manifest is None:
            parser.error("verify requires a manifest path")
        verify(args.revision, Path(args.path), Path(args.manifest))
