"""Every committed test module must actually yield unittest cases (audit AH-42).

The documented runner - `python -m unittest discover -s scripts/tests`, also what CI runs - is
stdlib unittest; the suite deliberately has no third-party dependency. A pytest-style module
(bare `test_*` functions, `pytest` fixtures) is IMPORTED by that runner and then contributes
zero cases: a green import that ran nothing. Measured 2026-09-05: one such module held 13
migration-safety tests that unittest collected as 0.

This guard loads every TRACKED test module and refuses one that yields no cases, naming it.
Only tracked files are judged, so a peer's in-flight, still-untracked file cannot turn the
suite red from another session; the moment it is committed it must conform (or this test
says so at the first CI run). Convert such a module to unittest.TestCase classes - there is no
second runner to switch to on purpose."""

import subprocess
import sys
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
SCRIPTS_DIR = TESTS_DIR.parent
sys.path.insert(0, str(SCRIPTS_DIR))
sys.path.insert(0, str(TESTS_DIR))


def _tracked_test_modules() -> list[Path]:
    try:
        out = subprocess.run(
            ["git", "ls-files", "--", "test_*.py"],
            cwd=str(TESTS_DIR), capture_output=True, text=True, timeout=30, check=True,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        # No git here (an exported tree): judge every module, which is the stricter reading.
        return sorted(TESTS_DIR.glob("test_*.py"))
    return sorted(TESTS_DIR / line.strip() for line in out.splitlines() if line.strip())


class CollectionGuardTest(unittest.TestCase):
    def test_every_tracked_test_module_yields_at_least_one_unittest_case(self):
        loader = unittest.TestLoader()
        empty: list[str] = []
        broken: list[str] = []
        modules = _tracked_test_modules()
        self.assertTrue(modules, "no test modules found - the guard itself is misplaced")
        for path in modules:
            if path.name == Path(__file__).name:
                continue
            name = path.stem
            try:
                module = __import__(name)
            except Exception as err:  # noqa: BLE001 - name the module, do not hide the cause
                broken.append(f"{path.name}: import failed ({type(err).__name__}: {err})")
                continue
            if loader.loadTestsFromModule(module).countTestCases() == 0:
                empty.append(path.name)
        self.assertEqual(broken, [], "test modules the documented runner cannot even import:\n  "
                                     + "\n  ".join(broken))
        self.assertEqual(
            empty, [],
            "test modules unittest collects as ZERO cases (pytest-style? convert to "
            "unittest.TestCase - the documented runner is stdlib unittest):\n  " + "\n  ".join(empty),
        )


if __name__ == "__main__":
    unittest.main()
