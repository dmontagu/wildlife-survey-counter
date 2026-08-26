from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import aiosqlite


async def init_db(db_path: Path) -> None:
    """Create tables if they don't exist."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    async with aiosqlite.connect(str(db_path)) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS detection_runs (
                id TEXT PRIMARY KEY,
                image_filename TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'running',
                started_at TEXT NOT NULL,
                completed_at TEXT,
                method_summary TEXT,
                animal_type TEXT,
                annotations TEXT,
                error TEXT
            )
        """)
        await db.execute("""
            CREATE INDEX IF NOT EXISTS idx_detection_runs_image
            ON detection_runs(image_filename)
        """)
        await db.commit()


async def get_db(db_path: Path) -> aiosqlite.Connection:
    db = await aiosqlite.connect(str(db_path))
    db.row_factory = aiosqlite.Row
    return db


def _row_to_dict(row: aiosqlite.Row) -> dict[str, Any]:
    d = dict(row)
    if d.get('annotations'):
        d['annotations'] = json.loads(d['annotations'])
    else:
        d['annotations'] = []
    return d


async def insert_detection_run(db: aiosqlite.Connection, run: dict[str, Any]) -> None:
    annotations = run.get('annotations')
    if annotations is not None and not isinstance(annotations, str):
        annotations = json.dumps(annotations)
    await db.execute(
        """INSERT INTO detection_runs
        (id, image_filename, status, started_at, completed_at,
         method_summary, animal_type, annotations, error)
        VALUES (:id, :image_filename, :status, :started_at, :completed_at,
         :method_summary, :animal_type, :annotations, :error)""",
        {
            'id': run['id'],
            'image_filename': run['image_filename'],
            'status': run.get('status', 'running'),
            'started_at': run['started_at'],
            'completed_at': run.get('completed_at'),
            'method_summary': run.get('method_summary'),
            'animal_type': run.get('animal_type'),
            'annotations': annotations,
            'error': run.get('error'),
        },
    )
    await db.commit()


async def update_detection_run(db: aiosqlite.Connection, run_id: str, **fields: Any) -> None:
    if 'annotations' in fields and not isinstance(fields['annotations'], str):
        fields['annotations'] = json.dumps(fields['annotations'])
    sets = ', '.join(f'{k} = :{k}' for k in fields)
    fields['id'] = run_id
    await db.execute(f'UPDATE detection_runs SET {sets} WHERE id = :id', fields)
    await db.commit()


async def get_detection_run(db: aiosqlite.Connection, run_id: str) -> dict[str, Any] | None:
    async with db.execute('SELECT * FROM detection_runs WHERE id = ?', (run_id,)) as cursor:
        row = await cursor.fetchone()
        return _row_to_dict(row) if row else None


async def list_detection_runs(db: aiosqlite.Connection, image_filename: str | None = None) -> list[dict[str, Any]]:
    if image_filename:
        query = 'SELECT * FROM detection_runs WHERE image_filename = ? ORDER BY started_at DESC'
        params: tuple = (image_filename,)
    else:
        query = 'SELECT * FROM detection_runs ORDER BY started_at DESC'
        params = ()
    async with db.execute(query, params) as cursor:
        rows = await cursor.fetchall()
        return [_row_to_dict(row) for row in rows]
