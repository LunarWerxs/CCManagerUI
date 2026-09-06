"""hydralib.sessions_all - the census that follows the daemon's pagination (audit AH-07).

sessions() is one page of at most 500 rows and never follows offset; a whole-account lane
that used it could report an account drained while unarchived work sat past row 500 (the
first page filled with archived history). sessions_all() pages to the end, de-duplicates
across pages, and RAISES on a failed page instead of returning a shorter list."""

import sys
import unittest
from pathlib import Path
from urllib.parse import parse_qs

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from stubdaemon import StubDaemon  # noqa: E402

from lib import hydralib  # noqa: E402


def _rows(n: int, archived_first: int) -> list[dict]:
    """n rows newest-first; the first `archived_first` are archived history, the rest are
    unarchived and OLDER - exactly the layout that hid work behind the 500-row page."""
    out = []
    for i in range(n):
        out.append({"session_id": f"s{i:05d}", "title": f"chat {i}",
                    "archived": i < archived_first, "instance": "inst1"})
    return out


class CensusTest(unittest.TestCase):
    def setUp(self):
        self.stub = StubDaemon()
        hydralib.BASE = self.stub.url
        self.calls: list[tuple[int, int]] = []

    def tearDown(self):
        self.stub.close()

    def _serve(self, rows: list[dict], fail_at_offset: int | None = None,
               insert_after_first_page: dict | None = None):
        state = {"rows": list(rows), "served": 0}

        def route(method, path, query, body):
            q = parse_qs(query)
            limit = int((q.get("limit") or ["200"])[0])
            offset = int((q.get("offset") or ["0"])[0])
            self.calls.append((limit, offset))
            if fail_at_offset is not None and offset == fail_at_offset:
                return 503, {"error": "not now"}
            page = state["rows"][offset:offset + limit]
            state["served"] += 1
            if insert_after_first_page is not None and state["served"] == 1:
                state["rows"].insert(0, insert_after_first_page)  # the list moves under us
            return {"sessions": page}

        self.stub.routes["/api/sessions"] = route

    def test_a_1203_row_account_is_enumerated_completely_past_the_first_page(self):
        rows = _rows(1203, archived_first=480)
        self._serve(rows)
        got = hydralib.sessions_all()
        self.assertEqual(len(got), 1203)
        self.assertEqual([r["session_id"] for r in got], [r["session_id"] for r in rows])
        # The older unarchived targets past row 500 are present - the whole point.
        self.assertTrue(all(not r["archived"] for r in got[480:]))
        self.assertEqual(self.calls, [(500, 0), (500, 500), (500, 1000)])

    def test_a_failed_page_raises_instead_of_returning_a_shorter_census(self):
        self._serve(_rows(1203, archived_first=480), fail_at_offset=500)
        with self.assertRaises(hydralib.DaemonError):
            hydralib.sessions_all()

    def test_a_row_arriving_mid_walk_neither_duplicates_nor_hides_the_originals(self):
        rows = _rows(1203, archived_first=480)
        newcomer = {"session_id": "brand-new", "title": "just started", "archived": False,
                    "instance": "inst1"}
        self._serve(rows, insert_after_first_page=newcomer)
        got = hydralib.sessions_all()
        ids = [r["session_id"] for r in got]
        self.assertEqual(len(ids), len(set(ids)), "a shifted row was counted twice")
        self.assertTrue(set(r["session_id"] for r in rows).issubset(ids), "an original row was lost")

    def test_a_small_account_is_one_page_and_the_old_default_window_is_untouched(self):
        self._serve(_rows(12, archived_first=3))
        self.assertEqual(len(hydralib.sessions_all()), 12)
        self.assertEqual(self.calls, [(500, 0)])
        # sessions() keeps its documented shape: one page, the caller's period, no offset.
        self.calls.clear()
        hydralib.sessions()
        self.assertEqual(self.calls, [(500, 0)])

    def test_a_malformed_page_raises(self):
        self.stub.routes["/api/sessions"] = lambda m, p, q, b: {"error": "renamed field"}
        with self.assertRaises(hydralib.DaemonError):
            hydralib.sessions_all()


if __name__ == "__main__":
    unittest.main()
