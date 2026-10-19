#!/usr/bin/env python3
"""Required pyflakes source gate; checker/IO failures fail closed.

Unused imports/locals are informational; undefined references and syntax are
release blockers. Include the reachable Bridge graph plus standalone tools.
"""
import sys
from pathlib import Path
try:
    from pyflakes.api import checkPath
    from pyflakes.messages import UndefinedName, UndefinedLocal
    from pyflakes.reporter import Reporter
except ImportError as exc:
    print('Required checker unavailable: pyflakes:', exc, file=sys.stderr)
    raise SystemExit(2)

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'ci'))
from runtime_coverage import bridge_inventory

class GateReporter(Reporter):
    def __init__(self):
        super().__init__(sys.stdout, sys.stderr)
        self.failed = False
    def flake(self, message):
        if isinstance(message, (UndefinedName, UndefinedLocal)):
            self.failed = True
            super().flake(message)
    def syntaxError(self, *args, **kwargs):
        self.failed = True
        super().syntaxError(*args, **kwargs)
    def unexpectedError(self, *args, **kwargs):
        self.failed = True
        super().unexpectedError(*args, **kwargs)

def main(paths=None):
    reporter = GateReporter()
    if paths is None:
        inventory = bridge_inventory(str(ROOT))
        if inventory['problems']:
            print('Bridge source inventory failed:', inventory['problems'], file=sys.stderr)
            return 2
        paths = [ROOT / row['path'] for row in inventory['local_modules'].values()]
        paths += [ROOT / 'irsdk-bridge' / n for n in ('dump_all_vars.py', 'log_strategy_timeseries.py')]
    for path in paths:
        checkPath(str(path), reporter)
    return 1 if reporter.failed else 0

if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:] or None))
