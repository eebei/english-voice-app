"""WO015 legacy VERSION1 checkpoint compat: a bundle written before a box
attempt had `confirmed_completed`/`confirmed_interrupted` keys at all (not
`False` -- missing) must migrate on read, never reject the whole bundle on
that alone, and never fabricate `True` it cannot derive from recorded report
evidence. The overnight /tmp probe that first found this gap used the real
`first_box` real-poll path and is gone; this reproduces the pre-migration
on-disk SHAPE from a genuinely-produced checkpoint (not a hand-authored
schema), explicitly as a regeneration -- not the same bytes as the lost probe.
"""
import copy, hashlib, json, subprocess, sys, tempfile, unittest
from pathlib import Path
import durable_recovery as dr
import box_authority_delivery as bd

HERE = Path(__file__).parent


def run(mode, path, exchange):
    p = subprocess.run([sys.executable, str(HERE / 'wo010_restart_runner.py'), mode, str(path), str(exchange)],
                        capture_output=True, text=True)
    if p.returncode:
        raise AssertionError(p.stderr)
    return json.loads(p.stdout)


def _strip_flags_and_resign(raw_path, flags):
    """Mutate a genuinely-produced checkpoint file in place: delete the named
    confirmation flag(s) from every box attempt, then re-sign the digest so
    the file is still a well-formed (self-consistent) VERSION1 checkpoint --
    exactly the shape a pre-WO015 writer would have produced, built from real
    recorded content rather than invented values."""
    body = json.loads(raw_path.read_text())
    attempts = body['domains']['box']['fields']['attempts']
    assert attempts, 'fixture run produced no box attempt to mutate'
    removed = 0
    for a in attempts.values():
        for f in flags:
            assert f in a, '%s missing before mutation -- fixture assumption broken' % f
            del a[f]
            removed += 1
    assert removed, 'mutation touched nothing'
    signed = {k: v for k, v in body.items() if k != 'digest'}
    body['digest'] = hashlib.sha256(dr.canonical(signed).encode()).hexdigest()
    raw_path.write_text(dr.canonical(body))


class LegacyCheckpointCompat(unittest.TestCase):
    def test_confirmed_completed_and_interrupted_missing_migrates_instead_of_rejecting(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / 'recovery.json'
            exchange = Path(td) / 'frames.json'
            run('first_box', path, exchange)

            before = dr.Store(str(path))
            self.assertIsNone(before.error)
            attempt_id, original = next(iter(before.loaded['decoded']['box'].attempts.items()))
            self.assertIn('confirmed_completed', original)
            self.assertIn('confirmed_interrupted', original)
            # Baseline for this fixture: freshly created, never reported.
            self.assertFalse(original['confirmed_completed'])
            self.assertFalse(original['confirmed_interrupted'])
            raw_before_mutation = json.loads(path.read_text())

            _strip_flags_and_resign(path, ('confirmed_completed', 'confirmed_interrupted'))

            # RED/control: the strict validator alone (no migration layer)
            # still rejects this exact legacy shape -- proves the fix below is
            # a migration step, not a relaxation of validate_domains itself.
            stripped_domains = json.loads(path.read_text())['domains']
            with self.assertRaises(dr.RecoveryError) as red:
                dr.validate_domains(dr.unpack(stripped_domains), raw_before_mutation['scope'])
            self.assertEqual(str(red.exception), 'box_attempt_schema')

            # GREEN: Store.read() migrates and loads successfully.
            after = dr.Store(str(path))
            self.assertIsNone(after.error)
            self.assertTrue(after.loaded['legacy_migrated'])
            migrated = after.loaded['decoded']['box'].attempts[attempt_id]
            # Derived from the (empty) report evidence -- never fabricated True.
            self.assertFalse(migrated['confirmed_completed'])
            self.assertFalse(migrated['confirmed_interrupted'])
            self.assertTrue(migrated['restored_history_only'])
            # confirmed_started was NOT stripped; migration must not touch a
            # flag that was already present.
            self.assertEqual(migrated['confirmed_started'], original['confirmed_started'])
            ledger = after.loaded['decoded']['box']
            decision_id = migrated['decision_id']
            self.assertFalse(bd.completed_for(ledger, decision_id))
            self.assertEqual(bd.audible_for(ledger, decision_id), original['confirmed_started'])

    def test_migration_derives_true_from_existing_report_evidence_not_blind_false(self):
        """If the legacy bundle's report evidence already proves completion
        (a real `audible_completed` report exists for the attempt) but the
        attempt-level flag itself is the thing missing, migration must derive
        True from that evidence -- defaulting blindly to False would silently
        discard a real historical fact instead of reconstructing it."""
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / 'recovery.json'
            exchange = Path(td) / 'frames.json'
            run('first_box', path, exchange)
            body = json.loads(path.read_text())
            attempts = body['domains']['box']['fields']['attempts']
            attempt_id, attempt = next(iter(attempts.items()))
            report_id = 'wo015-legacy-fixture-report'
            report = {k: attempt[k] for k in bd.BINDINGS}
            report.update(outcome='audible_completed', **attempt['canonical_dispatch_ref'])
            body['domains']['box']['fields']['reports'][report_id] = report
            # An audible_completed report implies started too; strip both so
            # migration must derive the whole (consistent) pair from evidence,
            # not just one flag in isolation.
            del attempt['confirmed_completed']
            del attempt['confirmed_started']
            signed = {k: v for k, v in body.items() if k != 'digest'}
            body['digest'] = hashlib.sha256(dr.canonical(signed).encode()).hexdigest()
            path.write_text(dr.canonical(body))

            store = dr.Store(str(path))
            self.assertIsNone(store.error)
            migrated = store.loaded['decoded']['box'].attempts[attempt_id]
            self.assertTrue(migrated['confirmed_completed'])
            self.assertTrue(migrated['confirmed_started'])
            self.assertTrue(migrated['restored_history_only'])


if __name__ == '__main__':
    unittest.main()
