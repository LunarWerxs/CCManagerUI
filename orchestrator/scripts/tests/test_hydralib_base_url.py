"""hydralib.resolve_base_url: the toolbox finds the daemon the way the MCP server does (audit
AH-04) - explicit URL, else explicit port, else the port the daemon ACTUALLY bound (its
runtime.json pointer), else 7787. Reproduced 2026-09-05: with AGENTHYDRA_PORT=17787 and no URL,
the toolbox still went to 7787."""

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lib import hydralib  # noqa: E402


class ResolveBaseUrlTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.home = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def _pointer(self, url, root=None):
        d = (root or self.home / ".agenthydra")
        d.mkdir(parents=True, exist_ok=True)
        (d / "runtime.json").write_text(json.dumps({"url": url, "port": 17787, "pid": 1}),
                                        encoding="utf-8")

    def test_the_default_is_7787_with_nothing_set_and_no_pointer(self):
        self.assertEqual(hydralib.resolve_base_url({}, self.home), "http://127.0.0.1:7787")

    def test_an_explicit_port_beats_the_default(self):
        self.assertEqual(hydralib.resolve_base_url({"AGENTHYDRA_PORT": "17787"}, self.home),
                         "http://127.0.0.1:17787")

    def test_the_bound_port_pointer_beats_the_default(self):
        self._pointer("http://127.0.0.1:7788")
        self.assertEqual(hydralib.resolve_base_url({}, self.home), "http://127.0.0.1:7788")

    def test_an_explicit_port_beats_the_pointer(self):
        self._pointer("http://127.0.0.1:7788")
        self.assertEqual(hydralib.resolve_base_url({"AGENTHYDRA_PORT": "17787"}, self.home),
                         "http://127.0.0.1:17787")

    def test_an_explicit_url_beats_everything_and_loses_its_trailing_slash(self):
        self._pointer("http://127.0.0.1:7788")
        env = {"AGENTHYDRA_URL": "http://127.0.0.1:9999/", "AGENTHYDRA_PORT": "17787"}
        self.assertEqual(hydralib.resolve_base_url(env, self.home), "http://127.0.0.1:9999")

    def test_agenthydra_home_relocates_the_pointer(self):
        other = self.home / "elsewhere"
        self._pointer("http://127.0.0.1:7790", root=other)
        self.assertEqual(hydralib.resolve_base_url({"AGENTHYDRA_HOME": str(other)}, self.home),
                         "http://127.0.0.1:7790")
        # and the default location is NOT consulted when AGENTHYDRA_HOME points elsewhere
        self._pointer("http://127.0.0.1:7791")
        self.assertEqual(hydralib.resolve_base_url({"AGENTHYDRA_HOME": str(other)}, self.home),
                         "http://127.0.0.1:7790")

    def test_a_malformed_or_non_http_pointer_is_ignored(self):
        d = self.home / ".agenthydra"
        d.mkdir(parents=True)
        (d / "runtime.json").write_text("{not json", encoding="utf-8")
        self.assertEqual(hydralib.resolve_base_url({}, self.home), "http://127.0.0.1:7787")
        (d / "runtime.json").write_text(json.dumps({"url": "file:///nope"}), encoding="utf-8")
        self.assertEqual(hydralib.resolve_base_url({}, self.home), "http://127.0.0.1:7787")

    def test_a_non_numeric_port_falls_through(self):
        self.assertEqual(hydralib.resolve_base_url({"AGENTHYDRA_PORT": "seven"}, self.home),
                         "http://127.0.0.1:7787")


if __name__ == "__main__":
    unittest.main()
