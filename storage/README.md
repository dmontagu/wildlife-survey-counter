# storage/

Runtime data directories. Contents are gitignored; the directory structure is committed via `.gitkeep` files.

| Directory   | Purpose                                              |
|-------------|------------------------------------------------------|
| `samples/`  | Sample images for the demo (e.g., elk aerial photos) |
| `uploads/`  | User-uploaded images                                  |
| `models/`   | Model weights (e.g., `yolov8x.pt`)                  |
| `output/`   | Research script output (visualizations, CSVs)        |

The backend creates `samples/` and `uploads/` on startup if missing, but having them pre-committed avoids that need after a fresh clone.
