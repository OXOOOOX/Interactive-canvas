#!/usr/bin/env python3
"""Offline control-flow tests for deploy/release.py.

Docker, GitHub, PostgreSQL and the real /opt/canvas tree are deliberately not
used.  The release module is exercised with temporary release directories and
mocked Compose/image commands so this suite also runs on Windows.
"""

import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import sys
import tempfile
import types
import unittest
from unittest import mock


HERE = Path(__file__).resolve().parent
RELEASE_SOURCE = HERE / "release.py"


def load_release_module():
    try:
        import fcntl  # type: ignore  # noqa: F401
    except ImportError:
        sys.modules["fcntl"] = types.SimpleNamespace(
            LOCK_EX=2,
            flock=lambda _file, _operation: None,
        )
    spec = importlib.util.spec_from_file_location("canvas_release_test", RELEASE_SOURCE)
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load deploy/release.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


release = load_release_module()


class ReleaseControlFlowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="canvas-release-test-")
        self.root = Path(self.temp.name)
        self.shared = self.root / "shared"
        (self.root / "releases").mkdir()
        self.shared.mkdir()
        (self.shared / "deploy-ready").write_text("ready\n", encoding="utf-8")
        (self.shared / "runtime-image.json").write_text(
            json.dumps({"image": "canvas-runtime:test", "image_id": "sha256:runtime"}),
            encoding="utf-8",
        )

        self.current = self.make_release("a" * 40)
        self.candidate = self.make_release("b" * 40)
        self.prior = self.make_release("c" * 40)
        self.pointers = {"current": self.current}
        self.compose_calls = []
        self.healthy_calls = []
        self.point_calls = []
        self.candidate_health_failure = False
        self.stop_failure = False

        self.original_root = release.ROOT
        self.original_shared = release.SHARED
        self.real_load_release = release.load_release
        release.ROOT = self.root
        release.SHARED = self.shared

        self.original_sighup = getattr(release.signal, "SIGHUP", None)
        if self.original_sighup is None:
            # Windows has no SIGHUP; release.py only needs a signal number for
            # installing and later ignoring its recovery handlers.
            release.signal.SIGHUP = signal.SIGTERM
        self.signal_numbers = list(dict.fromkeys([signal.SIGTERM, release.signal.SIGHUP]))
        self.original_handlers = {
            number: signal.getsignal(number) for number in self.signal_numbers
        }

        self.patches = [
            mock.patch.object(release.os, "geteuid", lambda: 0, create=True),
            mock.patch.object(release.fcntl, "flock", lambda *_args: None),
            mock.patch.object(release, "release_path", side_effect=self.fake_release_path),
            mock.patch.object(release, "load_release", side_effect=self.fake_load_release),
            mock.patch.object(release, "compose", side_effect=self.fake_compose),
            mock.patch.object(release, "healthy", side_effect=self.fake_healthy),
            mock.patch.object(release, "point", side_effect=self.fake_point),
        ]
        for patcher in self.patches:
            patcher.start()

    def tearDown(self):
        for patcher in reversed(self.patches):
            patcher.stop()
        for number, handler in self.original_handlers.items():
            signal.signal(number, handler)
        if self.original_sighup is None:
            del release.signal.SIGHUP
        release.ROOT = self.original_root
        release.SHARED = self.original_shared
        self.temp.cleanup()

    def make_release(self, revision, dependencies=None, server_auth=False):
        dependencies = dependencies or {}
        path = self.root / "releases" / revision
        source = path / "source"
        (source / "deploy").mkdir(parents=True)
        (source / "server").mkdir()
        if server_auth:
            (source / "server" / "auth").mkdir()

        tooling = {
            "compose.yaml": "services:\n  app:\n    image: ${CANVAS_IMAGE}\n",
            "deploy.sh": "#!/usr/bin/env bash\n",
            "release.py": "# verified release helper\n",
            "source-snapshot.py": "# verified source verifier\n",
        }
        for name, content in tooling.items():
            (source / "deploy" / name).write_text(content, encoding="utf-8")
            if name != "source-snapshot.py":
                (path / name).write_text(content, encoding="utf-8")
        (source / "package.json").write_text(
            json.dumps({"name": "canvas", "dependencies": dependencies}) + "\n",
            encoding="utf-8",
        )
        (source / "server" / "index.js").write_text("console.log('canvas');\n", encoding="utf-8")
        (path / "source-manifest.json").write_text("verified manifest\n", encoding="utf-8")
        manifest_hash = release.sha(path / "source-manifest.json")
        image = "sha256:" + revision
        (path / "build-receipt.json").write_text(
            json.dumps(
                {
                    "image_id": image,
                    "manifest_sha256": manifest_hash,
                    "runtime_id": "sha256:runtime",
                    "tests_passed": True,
                }
            ),
            encoding="utf-8",
        )
        return path

    def fake_release_path(self, value):
        text = str(value)
        if text == str(self.root / "current"):
            return self.current
        if text == str(self.candidate):
            return self.candidate
        if text == str(self.current):
            return self.current
        raise AssertionError(f"Unexpected release path: {value}")

    def fake_load_release(self, path, _runtime):
        return {"CANVAS_IMAGE": "sha256:" + path.name}

    def fake_compose(self, path, _env, *args, **_options):
        self.compose_calls.append((path, args))
        if self.stop_failure and path == self.current and args == ("stop", "app"):
            raise RuntimeError("stop command partially failed")

    def fake_healthy(self, path, _env, _timeout=120):
        self.healthy_calls.append(path)
        if path == self.candidate and self.candidate_health_failure:
            raise RuntimeError("candidate health failed")

    def fake_point(self, name, path):
        self.point_calls.append((name, path))
        self.pointers[name] = path

    def run_main(self, candidate=None):
        candidate = candidate or self.candidate
        with mock.patch.object(sys, "argv", [str(RELEASE_SOURCE), str(candidate)]):
            with contextlib.redirect_stdout(io.StringIO()):
                return release.main()

    def assert_config_first(self):
        self.assertTrue(self.compose_calls)
        self.assertEqual(self.compose_calls[0][1], ("config", "--quiet"))

    def test_success_switches_current_and_previous(self):
        self.run_main()

        self.assertEqual(self.pointers["current"], self.candidate)
        self.assertEqual(self.pointers["previous"], self.current)
        self.assertEqual(self.point_calls, [("previous", self.current), ("current", self.candidate)])
        self.assertEqual(self.healthy_calls, [self.candidate])
        self.assertIn(("stop", "app"), [args for _, args in self.compose_calls])
        self.assertIn(
            ("up", "-d", "--no-deps", "--force-recreate", "app"),
            [args for _, args in self.compose_calls],
        )
        audit = json.loads((self.shared / "last-release.json").read_text(encoding="utf-8"))
        self.assertEqual(audit["revision"], self.candidate.name)
        self.assertFalse(audit["business_backup_created"])

    def test_stop_failure_restores_old_program_and_current_pointer(self):
        self.stop_failure = True

        with self.assertRaisesRegex(RuntimeError, "stop command partially failed"):
            self.run_main()

        self.assertEqual(self.pointers["current"], self.current)
        self.assertNotIn("previous", self.pointers)
        self.assertEqual(self.healthy_calls, [self.current])
        self.assertNotIn(
            (self.candidate, ("up", "-d", "--no-deps", "--force-recreate", "app")),
            self.compose_calls,
        )

    def test_candidate_health_failure_restores_old_program_and_pointer(self):
        self.candidate_health_failure = True

        with self.assertRaisesRegex(RuntimeError, "candidate health failed"):
            self.run_main()

        self.assertEqual(self.pointers["current"], self.current)
        self.assertNotIn("previous", self.pointers)
        self.assertEqual(self.healthy_calls, [self.candidate, self.current])
        self.assertIn(
            (self.current, ("up", "-d", "--no-deps", "--force-recreate", "app")),
            self.compose_calls,
        )

    def test_audit_write_failure_after_switch_restores_both_pointers(self):
        self.pointers["previous"] = self.prior
        previous_link = self.root / "previous"
        original_is_symlink = release.Path.is_symlink
        original_resolve = release.Path.resolve
        original_replace = os.replace

        def fake_is_symlink(path):
            if path == previous_link:
                return True
            return original_is_symlink(path)

        def fake_resolve(path, *args, **kwargs):
            if path == previous_link:
                return self.prior
            return original_resolve(path, *args, **kwargs)

        def fail_audit_replace(source, destination):
            if Path(source).name == "last-release.tmp":
                raise OSError("audit write failed")
            return original_replace(source, destination)

        with mock.patch.object(release.Path, "is_symlink", fake_is_symlink), mock.patch.object(
            release.Path, "resolve", fake_resolve
        ), mock.patch.object(release.os, "replace", fail_audit_replace):
            with self.assertRaisesRegex(OSError, "audit write failed"):
                self.run_main()

        self.assertEqual(self.pointers["current"], self.current)
        self.assertEqual(self.pointers["previous"], self.prior)
        self.assertEqual(
            self.point_calls,
            [
                ("previous", self.current),
                ("current", self.candidate),
                ("current", self.current),
                ("previous", self.prior),
            ],
        )
        self.assertEqual(self.healthy_calls, [self.candidate, self.current])

    def test_same_current_release_is_idempotent(self):
        self.run_main(candidate=self.current)

        self.assertEqual(self.pointers, {"current": self.current})
        self.assertEqual(self.healthy_calls, [self.current])
        self.assertEqual(self.point_calls, [])
        self.assertEqual(self.compose_calls, [(self.current, ("config", "--quiet"))])

    def test_load_release_rejects_postgres_dependency(self):
        candidate = self.make_release("d" * 40, dependencies={"pg": "^8.0.0"})
        runtime = {"image": "canvas-runtime:test", "image_id": "sha256:runtime"}
        with mock.patch.object(release, "image_id", side_effect=self.fake_image_id), mock.patch.object(
            release, "run", return_value=types.SimpleNamespace(returncode=0)
        ):
            with self.assertRaisesRegex(AssertionError, "Configure and validate"):
                self.real_load_release(candidate, runtime)

    def test_load_release_rejects_server_auth_directory(self):
        candidate = self.make_release("e" * 40, server_auth=True)
        runtime = {"image": "canvas-runtime:test", "image_id": "sha256:runtime"}
        with mock.patch.object(release, "image_id", side_effect=self.fake_image_id), mock.patch.object(
            release, "run", return_value=types.SimpleNamespace(returncode=0)
        ):
            with self.assertRaisesRegex(AssertionError, "Configure and validate"):
                self.real_load_release(candidate, runtime)

    def test_load_release_accepts_stateless_version(self):
        candidate = self.make_release("f" * 40)
        runtime = {"image": "canvas-runtime:test", "image_id": "sha256:runtime"}
        with mock.patch.object(release, "image_id", side_effect=self.fake_image_id), mock.patch.object(
            release, "run", return_value=types.SimpleNamespace(returncode=0)
        ):
            env = self.real_load_release(candidate, runtime)
        self.assertEqual(env["CANVAS_IMAGE"], "sha256:" + candidate.name)

    @staticmethod
    def fake_image_id(image):
        if image == "canvas-runtime:test":
            return "sha256:runtime"
        if image.startswith("canvas:"):
            return "sha256:" + image.split(":", 1)[1]
        raise AssertionError(f"Unexpected image lookup: {image}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
