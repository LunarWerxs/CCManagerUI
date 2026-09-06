#!/usr/bin/env python3
"""run_locked.py - AH-16: run one scheduled lane's work under its proof-of-death job lock.

The generated .cmd wrapper (schedule_jobs.py) calls this instead of embedding the lock's
mkdir/rmdir logic as raw cmd/PowerShell text inside an `if ( ... )` block - besides moving the
ownership/heartbeat logic where it belongs (lib/joblocklib.py), it also removes the classic
footgun by removing the if-block: a ')' anywhere inside a cmd `if ( ... )` - even inside an
echo string in the untaken branch - aborts the WHOLE batch with exit 255 before anything runs
(hit this repo for real on 2026-09-01; see schedule_jobs.py's ARM_GUARD comment).

Usage: python run_locked.py <job> <work.cmd path>
Exit:  the work's own exit code, or 0 if this tick was SKIPPED because a live run already
       holds the lock (that is not a failure - it is the lock doing its job) - 3 bad usage.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib import clilib, joblocklib  # noqa: E402


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    if len(argv) != 2:
        print("usage: run_locked.py <job> <work.cmd path>", file=sys.stderr)
        return 3
    job, work = argv
    lock = joblocklib.acquire(job)
    if lock is None:
        print(f"[run_locked] SKIPPED - the previous {job} run is still going (or its "
              "ownership could not be confirmed dead).")
        return 0
    lock.start_heartbeat()
    try:
        # Pass-through on purpose: the lane's own output goes straight to the scheduler's log,
        # undecoded and unbuffered. Nothing here reads the child's bytes, so clilib.run_text
        # (which captures and decodes) is the wrong tool; `call` decodes nothing.
        return subprocess.call(["cmd", "/c", work])
    finally:
        if not lock.release():
            print(f"[run_locked] NOTE - the '{job}' lock was not this call's to remove by "
                  "the time it finished (a newer holder reclaimed it) - nothing was unlinked.")


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
