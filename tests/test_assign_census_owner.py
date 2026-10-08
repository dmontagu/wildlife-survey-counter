import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from scripts.assign_census_owner import assign_owner


class AssignCensusOwnerTests(unittest.TestCase):
    def test_assignment_is_explicit_idempotent_and_cannot_transfer_another_profiles_counts(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'runs.db'
            with sqlite3.connect(path) as db:
                db.execute('CREATE TABLE census_runs (id TEXT, payload TEXT, owner_key TEXT)')
                for run_id in ['mine', 'theirs']:
                    db.execute('INSERT INTO census_runs VALUES (?, ?, NULL)', (run_id, json.dumps({'id': run_id})))
            mine = '36632e3b-ef1a-4f28-8f53-68e1c14c8028'
            theirs = '5f6b4372-cd28-4b38-ae06-f0daa3212667'
            self.assertEqual(assign_owner(path, ['mine'], mine), 1)
            self.assertEqual(assign_owner(path, ['mine'], mine), 1)
            with self.assertRaises(ValueError):
                assign_owner(path, ['mine'], theirs)
            # A failed batch must not partially claim runs.
            with self.assertRaises(ValueError):
                assign_owner(path, ['theirs', 'missing'], theirs)
            with sqlite3.connect(path) as db:
                row = db.execute("SELECT payload, owner_key FROM census_runs WHERE id='mine'").fetchone()
                self.assertEqual(json.loads(row[0])['owner_key'], row[1])
                self.assertNotIn(mine, row[0])
                self.assertIsNone(db.execute("SELECT owner_key FROM census_runs WHERE id='theirs'").fetchone()[0])
