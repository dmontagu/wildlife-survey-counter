"""Expose the same bounded census tools to subscription-backed Codex CLI runs."""

from __future__ import annotations

import contextlib
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Literal, cast

from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp import Image as MCPImage
from mcp.types import ToolAnnotations
from pydantic_ai import RunContext

from wildlife_counter import counting_agent as impl


def main():
    work_dir = Path(sys.argv[1]).resolve()
    config = json.loads((work_dir / 'source.json').read_text())
    census = impl.Census(
        Path(config['image_path']),
        work_dir,
        config['width'],
        config['height'],
        region_size=config.get('region_size', 1600),
        final_review=config.get('final_review', True),
        species=config.get('species', 'elk'),
    )
    ctx = cast(RunContext[impl.Census], SimpleNamespace(deps=census))
    server = FastMCP('elk-census')
    local_tools = ToolAnnotations(destructiveHint=False, openWorldHint=False)

    @server.tool(annotations=local_tools)
    def get_ledger() -> dict:
        """Get disjoint region bounds and current review progress, in original image coordinates."""
        return impl.get_ledger(ctx)

    @server.tool(annotations=local_tools)
    def inspect_region(region: str, view: Literal['source', 'proposals', 'review'] = 'source') -> MCPImage:
        """View source pixels, detector proposals, or recorded points, with context and coordinate ticks."""
        result = impl.inspect_region(ctx, region, view)
        return MCPImage(data=result.data, format='jpeg')

    @server.tool(annotations=local_tools)
    def inspect_neighborhood(neighborhood: str) -> MCPImage:
        """Final cross-region duplicate/miss check: trace each marker to a distinct animal body."""
        result = impl.inspect_neighborhood(ctx, neighborhood)
        return MCPImage(data=result.data, format='jpeg')

    @server.tool(annotations=local_tools)
    def view_crop(left: int, top: int, right: int, bottom: int) -> MCPImage:
        """Inspect native source details and neighboring elk for context; maximum 2000px per side."""
        result = impl.view_crop(ctx, left, top, right, bottom)
        return MCPImage(data=result.data, format='jpeg')

    @server.tool(annotations=local_tools)
    def split_region(region: str) -> dict:
        """Subdivide a crowded region into four disjoint children for accurate counting."""
        return impl.split_region(ctx, region)

    @server.tool(annotations=local_tools)
    def record_region(region: str, points: list[impl.Point], uncertain: list[impl.PossiblePoint], notes: str) -> str:
        """Save original-coordinate torso points and separate possible animals after inspecting the region."""
        return impl.record_region(ctx, region, points, uncertain, notes)

    @server.tool(annotations=local_tools)
    def finish_census(summary: str) -> dict:
        """Finalize only after every region has been reviewed and recorded; no accuracy certification."""
        return impl.finish_census(ctx, summary)

    @server.tool(annotations=local_tools)
    async def detect_candidates() -> dict:
        """Optional elk detector proposals, including duplicates and false positives; inspect before counting."""
        # Native inference libraries print progress; never corrupt the MCP stdout protocol.
        with contextlib.redirect_stdout(sys.stderr):
            return await impl.detect_candidates(ctx)

    server.run(transport='stdio')


if __name__ == '__main__':
    main()
