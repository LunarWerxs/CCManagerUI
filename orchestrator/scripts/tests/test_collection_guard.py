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
second runner to switch to on purpose.

AND THE GUARD IS ITSELF PROVED TO FIRE (added 2026-09-06). Until then it had exactly the shape
it exists to forbid: its only assertion was that the real suite is clean, which is
indistinguishable from a guard whose detection is broken - both print one green line forever.
`GuardFiresTest` below runs the same detection over three synthetic modules, one pytest-style,
one that cannot import, one correct, and demands the first two be named and the third not. Break
the detection and that test goes red immediately, instead of in some future session that lands a
pytest module and never hears about it.
"""

import importlib.util
import shutil
import subprocess
import sys
import tempfile
import textwrap
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


def _import_by_name(path: Path):
    """How the documented runner reaches a module: by name, off sys.path, honouring the
    sys.modules cache so a module the runner already executed is not executed twice."""
    return __import__(path.stem)


def collection_failures(paths, importer=_import_by_name) -> tuple[list[str], list[str]]:
    """(collects-zero, cannot-import) for the given modules, each entry naming the file.

    Split out of the test so the guard's own detection can be exercised against synthetic
    modules - see GuardFiresTest. `importer` is the seam those fixtures use: they live in a temp
    directory that is not on sys.path, so they are loaded by file location instead of by name.
    """
    loader = unittest.TestLoader()
    empty: list[str] = []
    broken: list[str] = []
    for path in paths:
        try:
            module = importer(path)
        except Exception as err:  # noqa: BLE001 - name the module, do not hide the cause
            broken.append(f"{path.name}: import failed ({type(err).__name__}: {err})")
            continue
        if loader.loadTestsFromModule(module).countTestCases() == 0:
            empty.append(path.name)
    return empty, broken


class CollectionGuardTest(unittest.TestCase):
    def test_every_tracked_test_module_yields_at_least_one_unittest_case(self):
        modules = [p for p in _tracked_test_modules() if p.name != Path(__file__).name]
        self.assertTrue(modules, "no test modules found - the guard itself is misplaced")
        empty, broken = collection_failures(modules)
        self.assertEqual(broken, [], "test modules the documented runner cannot even import:\n  "
                                     + "\n  ".join(broken))
        self.assertEqual(
            empty, [],
            "test modules unittest collects as ZERO cases (pytest-style? convert to "
            "unittest.TestCase - the documented runner is stdlib unittest):\n  " + "\n  ".join(empty),
        )


# The three shapes the detection has to tell apart. PYTEST_STYLE is deliberately the real thing -
# a module-level `import pytest` and bare test functions - because that is what actually lands
# here, and a fixture that only omitted the TestCase would not prove the import survives.
PYTEST_STYLE = """
    import pytest

    @pytest.fixture
    def thing():
        return 1

    def test_a_bare_function_is_invisible_to_unittest(thing):
        assert thing == 1
"""
CANNOT_IMPORT = """
    import a_module_that_does_not_exist_anywhere  # noqa: F401

    import unittest

    class Fine(unittest.TestCase):
        def test_never_reached(self):
            pass
"""
CORRECT = """
    import unittest

    class Fine(unittest.TestCase):
        def test_this_one_really_runs(self):
            self.assertTrue(True)
"""


class GuardFiresTest(unittest.TestCase):
    """Proof that CollectionGuardTest's detection actually detects. Without this, the guard's
    green line means "the suite is clean" and "the guard is broken" equally well."""

    @staticmethod
    def _by_location(path: Path):
        """Fixtures live in a temp directory that is deliberately NOT on sys.path, so they are
        loaded by file location. Everything after the import - loadTestsFromModule counting the
        cases - is the same code the real guard runs."""
        spec = importlib.util.spec_from_file_location(f"_guardfixture_{path.stem}", path)
        if spec is None or spec.loader is None:
            raise ImportError(f"no loader for {path}")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def _fixtures(self, **bodies: str) -> list[Path]:
        root = Path(tempfile.mkdtemp(prefix="collection-guard-"))
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        paths = []
        for name, body in bodies.items():
            path = root / f"test_{name}.py"
            path.write_text(textwrap.dedent(body).lstrip(), encoding="utf-8")
            paths.append(path)
        return paths

    def test_a_pytest_style_module_is_named_as_collecting_zero(self):
        # Skipped rather than faked where pytest is absent: this fixture imports it for real, and
        # a fixture edited until it passes without pytest would stop being the shape that lands.
        try:
            import pytest  # noqa: F401
        except ImportError:
            self.skipTest("pytest is not installed here; the stdlib-only suite does not require it")
        paths = self._fixtures(pytest_style=PYTEST_STYLE)
        empty, broken = collection_failures(paths, importer=self._by_location)
        self.assertEqual(broken, [])
        self.assertEqual(empty, ["test_pytest_style.py"])

    def test_a_module_that_cannot_import_is_named_with_its_cause(self):
        paths = self._fixtures(cannot_import=CANNOT_IMPORT)
        empty, broken = collection_failures(paths, importer=self._by_location)
        self.assertEqual(empty, [])
        self.assertEqual(len(broken), 1, broken)
        self.assertIn("test_cannot_import.py", broken[0])
        self.assertIn("ModuleNotFoundError", broken[0])

    def test_a_correct_module_is_named_by_neither_list(self):
        # The other half of a trustworthy guard: one that flags everything is as useless as one
        # that flags nothing.
        paths = self._fixtures(correct=CORRECT)
        empty, broken = collection_failures(paths, importer=self._by_location)
        self.assertEqual((empty, broken), ([], []))

    def test_a_module_with_no_pytest_import_still_collects_as_zero(self):
        # The pytest-free half of the same failure, so this file keeps a real detection proof on
        # a machine that has no pytest at all (where the first test above skips).
        paths = self._fixtures(bare_functions="""
            def test_a_bare_function_is_invisible_to_unittest():
                assert True
        """)
        empty, broken = collection_failures(paths, importer=self._by_location)
        self.assertEqual(broken, [])
        self.assertEqual(empty, ["test_bare_functions.py"])


if __name__ == "__main__":
    unittest.main()
