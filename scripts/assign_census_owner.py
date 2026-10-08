"""Explicitly attach selected pre-identity local counts to one browser profile.

Run with --db and repeated --run IDs. Paste that profile's wsc:counting-client:v1
credential at the hidden prompt. Never put the credential in command-line arguments.
"""

from __future__ import annotations

import argparse
import getpass
import hashlib
import json
import sqlite3
import uuid
from pathlib import Path


def assign_owner(db_path: Path, run_ids: list[str], credential: str) -> int:
    token = uuid.UUID(credential)
    if token.version != 4:
        raise ValueError('Expected a version 4 browser credential')
    owner = hashlib.sha256(str(token).encode()).hexdigest()
    with sqlite3.connect(f'{db_path.resolve().as_uri()}?mode=rw', uri=True) as db:
        db.execute('BEGIN IMMEDIATE')
        for run_id in set(run_ids):
            row = db.execute('SELECT payload, owner_key FROM census_runs WHERE id=?', (run_id,)).fetchone()
            if row is None:
                raise ValueError(f'Unknown run: {run_id}')
            if row[1] is not None and row[1] != owner:
                raise ValueError(f'Run already belongs to a different profile: {run_id}')
            run = json.loads(row[0])
            run['owner_key'] = owner
            db.execute('UPDATE census_runs SET owner_key=?, payload=? WHERE id=?', (owner, json.dumps(run), run_id))
    return len(set(run_ids))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', type=Path, required=True)
    parser.add_argument('--run', action='append', required=True, dest='run_ids')
    args = parser.parse_args()
    count = assign_owner(args.db, args.run_ids, getpass.getpass('Browser counting credential (hidden): '))
    print(f'Assigned {count} saved counts. Refresh that browser to use them. No AI work was started.')


if __name__ == '__main__':
    main()
