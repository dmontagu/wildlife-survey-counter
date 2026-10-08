from pathlib import Path
from typing import Literal

from pydantic_settings import BaseSettings

_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent


class Settings(BaseSettings):
    model_config = {'env_prefix': 'WSC_'}

    samples_dir: Path = _PROJECT_ROOT / 'storage' / 'samples'
    uploads_dir: Path = _PROJECT_ROOT / 'storage' / 'uploads'
    frontend_dist_dir: Path = _PROJECT_ROOT / 'src' / 'frontend' / 'dist'
    db_path: Path = _PROJECT_ROOT / 'storage' / 'wsc.db'
    sandbox_work_dir: Path = _PROJECT_ROOT / 'storage' / 'sandbox'
    detection_model: str = 'anthropic:claude-sonnet-5'
    sandbox_timeout: int = 120
    max_tool_calls: int = 15
    counting_enabled: bool = False
    counting_runner: Literal['codex', 'api'] = 'codex'
    counting_model: str = 'openai-responses:gpt-6-astra'
    counting_request_limit: int = 200
    counting_output_token_limit: int = 100_000
    counting_weights: Path = _PROJECT_ROOT / 'runs/detect/storage/models/runs/elk_yolo11s_v4/weights/best.pt'
    port: int = 8100
    host: str = '0.0.0.0'
    # Enable uvicorn's auto-reloader (dev only). Also settable with --reload.
    reload: bool = False


settings = Settings()
