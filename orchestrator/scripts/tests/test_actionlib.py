"""lib/actionlib.CATALOG - THE ACTION CATALOG contract (AH-25).

Before this file, "is this script observe or act, direct or unattended" lived in three places
that could each be read differently: orch.py's menu inferred kind from the first line of a
docstring (fragile enough that migrate_batch.py, interview.py, run_locked.py and smoke.py were
silently sorted into a leftover "other" bucket); the bridge/header/handshake described every
action as icon-gated; and lib/armlib.py's docstring separately explained the one documented
escape hatch (a person's own --force) without naming which scripts reach it. This file pins
the catalog against the two things that must never be able to drift from it again: the actual
files on disk, and lib/armlib's own gated-script set."""

import json
import sys
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # orch.py lives at the repo root
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(Path(__file__).resolve().parent))  # tests/util.py

from lib import actionlib  # noqa: E402
from lib import armlib  # noqa: E402

# Non-runnable helper modules under scripts/ - never expected to carry a CATALOG entry.
# actionlib enumerates one entry per script under orchestrator/scripts/*.py, skipping lib/,
# actuator/ and tests/ - the same scope orch.py's own SCRIPTS.glob("*.py") already has,
# because lib/ and actuator/ are subdirectories a non-recursive glob never sees in the first
# place. Nothing needs excluding here beyond that.
SCRIPT_FILES = {p.stem for p in SCRIPTS.glob("*.py")}


class CatalogCoversDiskTest(unittest.TestCase):
    def test_every_script_file_has_a_catalog_entry(self):
        missing = SCRIPT_FILES - set(actionlib.CATALOG)
        self.assertEqual(missing, set(), f"on disk but not catalogued: {sorted(missing)}")

    def test_every_catalog_entry_has_a_script_file(self):
        orphaned = set(actionlib.CATALOG) - SCRIPT_FILES
        self.assertEqual(orphaned, set(), f"catalogued but no such file: {sorted(orphaned)}")

    def test_driver_words_are_not_catalog_entries(self):
        # arm/disarm/armed/resume/pause/loop are orch.py's own switch group, not scripts -
        # they have no scripts/<name>.py file and must never be mistaken for one.
        overlap = actionlib.DRIVER_WORDS & set(actionlib.CATALOG)
        self.assertEqual(overlap, set())
        for word in actionlib.DRIVER_WORDS:
            self.assertNotIn(word, SCRIPT_FILES, f"{word} unexpectedly has a script file too")


class CatalogShapeTest(unittest.TestCase):
    def test_kinds_are_from_the_allowed_set(self):
        for name, row in actionlib.CATALOG.items():
            self.assertIn(row["kind"], actionlib.KINDS, name)

    def test_invocations_are_from_the_allowed_set(self):
        for name, row in actionlib.CATALOG.items():
            self.assertIn(row["invocation"], actionlib.INVOCATIONS, name)

    def test_platforms_are_from_the_allowed_set(self):
        for name, row in actionlib.CATALOG.items():
            self.assertIn(row["platforms"], actionlib.PLATFORMS, name)

    def test_guards_are_from_the_allowed_set(self):
        for name, row in actionlib.CATALOG.items():
            for g in row["guards"]:
                self.assertIn(g, actionlib.GUARDS, f"{name}: {g!r}")

    def test_availability_is_from_the_allowed_set(self):
        for name, row in actionlib.CATALOG.items():
            self.assertIn(row["availability"], actionlib.AVAILABILITIES, name)

    def test_every_disabled_entry_names_a_reason(self):
        for name, row in actionlib.CATALOG.items():
            if row["availability"] == "disabled":
                self.assertTrue(str(row.get("reason") or "").strip(),
                                 f"{name} is disabled with no reason")

    def test_every_entry_has_a_non_empty_summary_and_result(self):
        for name, row in actionlib.CATALOG.items():
            self.assertTrue(str(row.get("summary") or "").strip(), name)
            self.assertTrue(str(row.get("result") or "").strip(), name)


class ArmlibAgreementTest(unittest.TestCase):
    """The direct-vs-unattended split in the catalog must equal what lib/armlib itself
    allows - checked against armlib's OWN predicate, never a second copy of its set."""

    def test_both_scripts_are_exactly_armlibs_gated_scripts(self):
        catalog_both = {n for n, r in actionlib.CATALOG.items() if r["invocation"] == "both"}
        self.assertEqual(catalog_both, set(armlib.GATED_SCRIPTS))

    def test_requires_arm_check_agrees_with_the_catalog_for_every_script(self):
        for name, row in actionlib.CATALOG.items():
            if row["invocation"] == "unattended":
                continue  # run_locked: gated one layer up in the generated wrapper, not via
                          # an in-process armlib call - armlib.requires_arm_check correctly
                          # says False for it, and that is not a disagreement.
            self.assertEqual(
                row["invocation"] == "both", armlib.requires_arm_check(name),
                f"{name}: catalog says invocation={row['invocation']!r} but "
                f"armlib.requires_arm_check() says {armlib.requires_arm_check(name)}")

    def test_direct_scripts_never_call_refuse_unless_armed(self):
        # A grep-level cross-check that the catalog's "direct" claim is actually true in the
        # source, not merely consistent with armlib's set (which is itself hand-maintained).
        for name, row in actionlib.CATALOG.items():
            if row["invocation"] != "direct":
                continue
            src = (SCRIPTS / f"{name}.py").read_text(encoding="utf-8")
            self.assertNotIn("armlib.refuse_unless_armed", src,
                              f"{name} is catalogued direct but calls armlib.refuse_unless_armed")

    def test_migrate_chat_is_still_the_documented_direct_exception(self):
        # The one exception AH-25 was told never to change: migrate_chat.py stays reachable
        # with no armed-window check, exactly as it is today.
        self.assertEqual(actionlib.CATALOG["migrate_chat"]["invocation"], "direct")
        self.assertIsNone(armlib.refuse_unless_armed_for("migrate_chat", [], "test"))

    def test_refuse_unless_armed_for_still_gates_an_unattended_script(self):
        # sweep.py is in GATED_SCRIPTS; with no tray up and no --force, the catalog-consulting
        # form must refuse exactly like the direct call already does.
        self.assertIsNotNone(armlib.refuse_unless_armed_for("sweep", [], "test"))
        self.assertIsNone(armlib.refuse_unless_armed_for("sweep", ["--force"], "test"))


class MenuGeneratedFromCatalogTest(unittest.TestCase):
    def test_the_menu_lists_every_catalog_entry_exactly_once(self):
        import orch

        rows = orch._catalog()
        names = [r["name"] for r in rows]
        self.assertEqual(len(names), len(set(names)), "a name appears twice")
        self.assertEqual(set(names), set(actionlib.CATALOG))

    def test_show_menu_prints_every_script_name_once(self):
        import contextlib
        import io

        import orch

        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = orch.show_menu()
        self.assertEqual(code, 0)
        # A row is "    <name>   <summary...>" - match the name as its own leading token so a
        # script whose name is also an ordinary English word used in someone ELSE's summary
        # (e.g. "chats", used constantly in prose) is not miscounted as printed twice.
        rows = [ln.split(None, 1)[0] for ln in buf.getvalue().splitlines()
                if ln[:4] == "    " and ln[4:5] != " " and ln.strip()]
        for name in actionlib.CATALOG:
            self.assertEqual(rows.count(name), 1, f"{name} appears as a row {rows.count(name)} times")

    def test_unknown_script_dispatch_is_unaffected_by_the_catalog(self):
        # main()'s "unknown script" check reads the real files on disk (_scripts_on_disk),
        # not the catalog, so a script that exists but is not yet catalogued would still run -
        # this is the regression rail for that design choice.
        import orch

        self.assertEqual(orch._scripts_on_disk(), SCRIPT_FILES)


class CatalogJsonRoundTripTest(unittest.TestCase):
    def test_catalog_serializes_and_round_trips_as_json(self):
        text = json.dumps(actionlib.CATALOG, default=str)
        back = json.loads(text)
        self.assertEqual(set(back), set(actionlib.CATALOG))
        for name, row in actionlib.CATALOG.items():
            self.assertEqual(list(back[name]["guards"]), list(row["guards"]))
            self.assertEqual(back[name]["kind"], row["kind"])
            self.assertEqual(back[name]["invocation"], row["invocation"])

    def test_orch_dash_dash_catalog_prints_valid_json_covering_every_entry(self):
        from util import run_cli

        import orch

        code, out, err = run_cli(orch.main, ["--catalog"])
        self.assertEqual(code, 0, err)
        parsed = json.loads(out)
        self.assertEqual(set(parsed), set(actionlib.CATALOG))


if __name__ == "__main__":
    unittest.main()
