import copy
import tempfile
from pathlib import Path
import subprocess
import sys
import unittest
from review_evidence import CONTROL_IDS, validate


def record():
    return {'schema_version': 1, 'project': 'fixture', 'revision': 'test-revision', 'created_at': '2026-10-03T00:00:00Z',
            'scope': {'environment': 'local', 'targets': ['fixture']},
            'controls': [{'id': cid, 'status': 'not_applicable', 'reason': 'Fixture does not expose this boundary'} for cid in CONTROL_IDS]}


class EvidenceTests(unittest.TestCase):
    def test_unreviewed_cannot_be_complete(self):
        r = record()
        r['controls'][0]['status'] = 'unreviewed'
        self.assertEqual(validate(r), [])
        self.assertTrue(validate(r, complete=True))

    def test_claim_requires_code_test_and_observation(self):
        r = record()
        r['controls'][0] = {'id': CONTROL_IDS[0], 'status': 'verified', 'invariant': 'Untrusted input remains data',
                            'code': ['fixture/app.py:10'], 'tests': ['test_injection'],
                            'evidence': [{'command': 'python3 -m unittest', 'result': '1 passed', 'observed_at': '2026-10-03T00:00:00Z'}]}
        self.assertEqual(validate(r, True), [])
        for field in ('code', 'tests', 'evidence', 'invariant'):
            broken = copy.deepcopy(r)
            broken['controls'][0].pop(field)
            self.assertTrue(validate(broken, True), field)

    def test_duplicates_missing_controls_and_bad_shapes_fail(self):
        r = record()
        r['controls'][1] = copy.deepcopy(r['controls'][0])
        self.assertTrue(validate(r, True))
        for bad in (None, [], {'controls': {}}, {**record(), 'controls': [{'id': []}]}):
            self.assertTrue(validate(bad, True))

    def test_gap_is_not_a_pass_but_can_complete_an_honest_review(self):
        r = record()
        r['controls'][0] = {'id': CONTROL_IDS[0], 'status': 'gap', 'impact': 'Cross-owner data exposure', 'next_action': 'Add object authorization and regression test'}
        self.assertEqual(validate(r, True), [])
        r['controls'][0].pop('next_action')
        self.assertTrue(validate(r, True))

    def test_init_does_not_overwrite_existing_report(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            subprocess.run(['git', 'init', '-q', str(repo)], check=True)
            subprocess.run(['git', '-C', str(repo), '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
                            'commit', '--allow-empty', '-qm', 'fixture'], check=True)
            target = repo / 'review.json'
            command = [sys.executable, str(Path(__file__).with_name('review_evidence.py')), 'init', '--repo', str(repo), '--output', str(target)]
            self.assertEqual(subprocess.run(command, capture_output=True).returncode, 0)
            original = target.read_bytes()
            self.assertEqual(subprocess.run(command, capture_output=True).returncode, 2)
            self.assertEqual(target.read_bytes(), original)


if __name__ == '__main__':
    unittest.main()
