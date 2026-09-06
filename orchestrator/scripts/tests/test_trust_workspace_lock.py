"""trust_workspace.py: AH-17 - two independent trust invocations (a spawn and a migrate, say)
used to read-modify-write ~/.claude.json with no coordination and a fixed temp-file name, so
a project addition could be lost or two writers could collide on the temp file. Covers: real
concurrent writers both surviving, no fixed-name temp file ever appearing, and the external
(non-cooperating) writer guard - a single outside edit is preserved and re-merged, a writer
that never stops changing the file is refused rather than clobbered."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import trust_workspace  # noqa: E402


class _IsolatedConfigTest(unittest.TestCase):
    """Shared setup: a temp CONFIG file plus a temp ORCHESTRATOR_STATE_DIR, since apply_trust
    now serializes on ledgerlib's cross-process lock, which lives under that env var."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.cfg = Path(self._tmp.name) / ".claude.json"
        self.cfg.write_text(json.dumps({"projects": {}}), encoding="utf-8")
        self._old_config = trust_workspace.CONFIG
        trust_workspace.CONFIG = self.cfg
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name

    def tearDown(self):
        trust_workspace.CONFIG = self._old_config
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._state.cleanup()
        self._tmp.cleanup()


class ConcurrentTrustTest(_IsolatedConfigTest):
    def test_two_concurrent_project_additions_both_survive(self):
        barrier = threading.Barrier(2)
        errors: list[Exception] = []

        def worker(path: str) -> None:
            try:
                barrier.wait(timeout=5)
                trust_workspace.apply_trust([path], act=True)
            except Exception as exc:  # noqa: BLE001 - captured for the assertion below
                errors.append(exc)

        threads = [
            threading.Thread(target=worker, args=("D:/Repos/One",)),
            threading.Thread(target=worker, args=("D:/Repos/Two",)),
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=10)

        self.assertEqual(errors, [], "neither concurrent writer should raise")
        cfg = json.loads(self.cfg.read_text(encoding="utf-8"))
        self.assertTrue(cfg["projects"].get("D:/Repos/One", {}).get("hasTrustDialogAccepted"))
        self.assertTrue(cfg["projects"].get("D:/Repos/Two", {}).get("hasTrustDialogAccepted"))

    def test_no_fixed_name_temp_file_is_left_or_ever_used(self):
        barrier = threading.Barrier(2)

        def worker(path: str) -> None:
            barrier.wait(timeout=5)
            trust_workspace.apply_trust([path], act=True)

        threads = [
            threading.Thread(target=worker, args=("D:/Repos/Three",)),
            threading.Thread(target=worker, args=("D:/Repos/Four",)),
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=10)

        fixed_name_tmp = self.cfg.with_name(f"{self.cfg.name}.trust.tmp")
        self.assertFalse(fixed_name_tmp.exists(), "the old fixed '.trust.tmp' must never appear")
        leftovers = list(self.cfg.parent.glob(f"{self.cfg.name}.*.trust.tmp"))
        self.assertEqual(leftovers, [], f"pid-unique temp files must be cleaned up: {leftovers}")


class ExternalWriterTest(_IsolatedConfigTest):
    def test_a_single_external_edit_between_read_and_replace_is_preserved(self):
        # Hook the real save() so its FIRST call simulates a non-cooperating external writer
        # (the desktop app) rewriting CONFIG directly, after trust_workspace already read it
        # but before its replace lands - the real stat check inside save() must catch this
        # and refuse; apply_trust must then re-read, re-merge, and retry rather than clobber.
        original_save = trust_workspace.save
        calls = {"n": 0}

        def hooked_save(cfg, expect_stat=None):
            calls["n"] += 1
            if calls["n"] == 1:
                external = json.loads(self.cfg.read_text(encoding="utf-8"))
                external.setdefault("projects", {})["D:/Repos/External"] = {
                    "hasTrustDialogAccepted": True
                }
                self.cfg.write_text(json.dumps(external), encoding="utf-8")
            return original_save(cfg, expect_stat=expect_stat)

        with mock.patch.object(trust_workspace, "save", side_effect=hooked_save):
            result = trust_workspace.apply_trust(["D:/Repos/Mine"], act=True)

        self.assertEqual(calls["n"], 2, "one refusal, then one successful retry")
        self.assertEqual(result["trusted"], ["D:/Repos/Mine"])
        cfg = json.loads(self.cfg.read_text(encoding="utf-8"))
        # The external writer's row survived the re-merge...
        self.assertTrue(cfg["projects"]["D:/Repos/External"]["hasTrustDialogAccepted"])
        # ...and so did ours - neither was clobbered by the other.
        self.assertTrue(cfg["projects"]["D:/Repos/Mine"]["hasTrustDialogAccepted"])

    def test_a_writer_that_never_stops_changing_config_is_refused_not_clobbered(self):
        original_save = trust_workspace.save
        calls = {"n": 0}

        def hooked_save(cfg, expect_stat=None):
            calls["n"] += 1
            # Mutate CONFIG again on every single attempt, so the stat check can never line up
            # - an external writer that simply never settles.
            external = json.loads(self.cfg.read_text(encoding="utf-8"))
            external.setdefault("projects", {})[f"D:/Repos/Ext{calls['n']}"] = {
                "hasTrustDialogAccepted": True
            }
            self.cfg.write_text(json.dumps(external), encoding="utf-8")
            return original_save(cfg, expect_stat=expect_stat)

        with mock.patch.object(trust_workspace, "save", side_effect=hooked_save):
            with self.assertRaises(trust_workspace.ExternalWriteError):
                trust_workspace.apply_trust(["D:/Repos/Mine"], act=True)

        self.assertEqual(calls["n"], trust_workspace.RETRY_ATTEMPTS,
                          "must give up after the bounded number of attempts, not loop forever")
        cfg = json.loads(self.cfg.read_text(encoding="utf-8"))
        self.assertNotIn("D:/Repos/Mine", cfg["projects"],
                          "a refusal must never half-apply a stale merge")


if __name__ == "__main__":
    unittest.main()
