#!/usr/bin/env python3
"""Create/check security review evidence records; never run recorded commands."""
import argparse
import datetime as dt
import json
from pathlib import Path
import subprocess
import sys

CONTROL_IDS = (
    'input-output', 'browser', 'transport-secrets', 'authentication', 'session',
    'authorization', 'outbound', 'resource-cost', 'privilege-dependencies', 'operations',
)
STATUSES = {'unreviewed', 'verified', 'gap', 'not_applicable'}


def nonempty(value):
    return isinstance(value, str) and bool(value.strip())


def strings(value):
    return isinstance(value, list) and bool(value) and all(nonempty(v) for v in value)


def validate(record, complete=False):
    errors = []
    if not isinstance(record, dict):
        return ['record must be an object']
    if record.get('schema_version') != 1:
        errors.append('unsupported schema_version')
    for field in ('project', 'revision', 'created_at'):
        if not nonempty(record.get(field)):
            errors.append(f'{field} is required')
    scope = record.get('scope', {})
    if not isinstance(scope, dict) or not nonempty(scope.get('environment')) or not strings(scope.get('targets')):
        errors.append('scope needs environment and non-empty targets')
    controls = record.get('controls')
    if not isinstance(controls, list):
        return errors + ['controls must be a list']
    seen = set()
    for control in controls:
        if not isinstance(control, dict):
            errors.append('control must be an object')
            continue
        cid = control.get('id')
        if not isinstance(cid, str) or cid not in CONTROL_IDS or cid in seen:
            errors.append('unknown or duplicate control id')
            continue
        seen.add(cid)
        status = control.get('status')
        if not isinstance(status, str) or status not in STATUSES:
            errors.append(f'{cid}: invalid status')
            continue
        if status == 'unreviewed':
            if complete:
                errors.append(f'{cid}: unreviewed')
        elif status == 'not_applicable':
            if not nonempty(control.get('reason')):
                errors.append(f'{cid}: applicability reason required')
        elif status == 'gap':
            if not nonempty(control.get('impact')) or not nonempty(control.get('next_action')):
                errors.append(f'{cid}: impact and next_action required')
        elif status == 'verified':
            for field in ('invariant',):
                if not nonempty(control.get(field)):
                    errors.append(f'{cid}: {field} required')
            for field in ('code', 'tests'):
                if not strings(control.get(field)):
                    errors.append(f'{cid}: {field} evidence required')
            evidence = control.get('evidence')
            if not isinstance(evidence, list) or not evidence:
                errors.append(f'{cid}: observed evidence required')
            else:
                for item in evidence:
                    if not isinstance(item, dict) or any(not nonempty(item.get(f)) for f in ('command', 'result', 'observed_at')):
                        errors.append(f'{cid}: each observation needs command, result and observed_at')
    if seen != set(CONTROL_IDS):
        errors.append('every control must be present; use not_applicable with a reason')
    return errors


def init_record(repo):
    def git(*args):
        return subprocess.run(['git', '-C', str(repo), *args], check=True, capture_output=True, text=True).stdout.strip()
    root = git('rev-parse', '--show-toplevel')
    return {
        'schema_version': 1,
        'project': Path(root).name,
        'revision': git('rev-parse', 'HEAD'),
        'dirty_at_start': bool(git('status', '--porcelain')),
        'created_at': dt.datetime.now(dt.timezone.utc).isoformat(),
        'scope': {'environment': 'local', 'targets': ['application code'], 'excluded': ['live attack traffic']},
        'sources': [],
        'controls': [{'id': cid, 'status': 'unreviewed', 'invariant': '', 'code': [], 'tests': [], 'evidence': [],
                      'reason': '', 'impact': '', 'next_action': ''} for cid in CONTROL_IDS],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    init = sub.add_parser('init', help='Create a new record from read-only Git metadata')
    init.add_argument('--repo', type=Path, required=True)
    init.add_argument('--output', type=Path, required=True)
    check = sub.add_parser('check', help='Check record completeness, not application security')
    check.add_argument('record', type=Path)
    check.add_argument('--complete', action='store_true')
    args = parser.parse_args()
    try:
        if args.action == 'init':
            record = init_record(args.repo)
            # Exclusive create protects a prior assessment from accidental overwrite.
            with args.output.open('x', encoding='utf-8') as stream:
                json.dump(record, stream, ensure_ascii=False, indent=2)
                stream.write('\n')
            print(f'Created {args.output}; all controls remain unreviewed.')
        else:
            record = json.loads(args.record.read_text(encoding='utf-8'))
            errors = validate(record, args.complete)
            if errors:
                for error in errors:
                    print(error, file=sys.stderr)
                return 1
            counts = {s: sum(c['status'] == s for c in record['controls']) for s in sorted(STATUSES)}
            print(json.dumps(counts))
            print('Record format valid. This does not approve security or release readiness.')
    except (OSError, ValueError, subprocess.CalledProcessError):
        print('Cannot read or create review record; check paths, JSON, and Git repository.', file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
