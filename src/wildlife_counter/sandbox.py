from __future__ import annotations

import asyncio
import base64
import shutil
from abc import ABC, abstractmethod
from pathlib import Path

import logfire
from pydantic import BaseModel


class RunResult(BaseModel):
    stdout: str
    stderr: str
    exit_code: int
    output_files: list[str]


class Sandbox(ABC):
    @abstractmethod
    async def start(self) -> None: ...

    @abstractmethod
    async def execute(self, code: str, timeout: int = 120) -> RunResult: ...

    @abstractmethod
    async def read_file(self, path: str) -> str: ...

    @abstractmethod
    async def stop(self) -> None: ...


class SubprocessSandbox(Sandbox):
    """Run code via subprocess in a work directory. No isolation — suitable for v1."""

    def __init__(self, work_dir: Path):
        self.work_dir = work_dir

    async def start(self) -> None:
        self.work_dir.mkdir(parents=True, exist_ok=True)

    @logfire.instrument('sandbox.execute')
    async def execute(self, code: str, timeout: int = 120) -> RunResult:
        script_path = self.work_dir / '_script.py'
        script_path.write_text(code)
        proc = await asyncio.create_subprocess_exec(
            'python',
            str(script_path),
            cwd=str(self.work_dir),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except TimeoutError:
            proc.kill()
            await proc.communicate()
            return RunResult(
                stdout='',
                stderr=f'Execution timed out after {timeout}s',
                exit_code=-1,
                output_files=[],
            )

        output_files = [
            f.name
            for f in self.work_dir.iterdir()
            if f.is_file() and f.name not in ('_script.py',) and not f.name.startswith('input.')
        ]

        return RunResult(
            stdout=(stdout or b'').decode('utf-8', errors='replace')[:10000],
            stderr=(stderr or b'').decode('utf-8', errors='replace')[:5000],
            exit_code=proc.returncode or 0,
            output_files=sorted(output_files),
        )

    async def read_file(self, path: str) -> str:
        # Prevent path traversal
        clean = Path(path.lstrip('/'))
        if '..' in clean.parts:
            return 'Error: path traversal not allowed'
        full_path = self.work_dir / clean
        if not full_path.is_file():
            return f'Error: file not found: {path}'
        if not full_path.resolve().is_relative_to(self.work_dir.resolve()):
            return 'Error: path traversal not allowed'

        if full_path.suffix.lower() in ('.jpg', '.jpeg', '.png', '.gif', '.webp'):
            data = full_path.read_bytes()
            if len(data) > 50_000 * 1024:  # 50MB cap
                return 'Error: file too large for base64 encoding'
            b64 = base64.b64encode(data).decode()
            media_type = {
                '.jpg': 'image/jpeg',
                '.jpeg': 'image/jpeg',
                '.png': 'image/png',
                '.gif': 'image/gif',
                '.webp': 'image/webp',
            }.get(full_path.suffix.lower(), 'application/octet-stream')
            return f'data:{media_type};base64,{b64}'

        text = full_path.read_text(errors='replace')
        return text[:50000]

    async def stop(self) -> None:
        shutil.rmtree(self.work_dir, ignore_errors=True)
