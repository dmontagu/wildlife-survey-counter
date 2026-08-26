# storage/

Runtime data directories. Contents are gitignored; the directory structure is committed via `.gitkeep` files.

| Directory   | Purpose                                                                             |
|-------------|-------------------------------------------------------------------------------------|
| `samples/`  | Sample images served at `/samples/` (`WSC_SAMPLES_DIR`)                              |
| `uploads/`  | Images received by `POST /api/upload`, served at `/uploads/` (`WSC_UPLOADS_DIR`)     |
| `sandbox/`  | Per-run working directories for agent detection (`WSC_SANDBOX_WORK_DIR`)             |
| `models/`   | Model weights. The `scripts/*.py` evaluation scripts expect `storage/models/yolov8x.pt` here; nothing in the repo fetches it for you |
| `output/`   | Research output. The `scripts/*.py` scripts write here directly (`storage/output/<run>/`); the `research/` scripts instead write to `./output/` relative to the working directory |

`wsc.db` (SQLite, `WSC_DB_PATH`) also lands here: it records agent detection runs and is created on startup.

The backend creates `samples/`, `uploads/`, and `sandbox/` on startup if missing, but having them pre-committed avoids that need after a fresh clone.
