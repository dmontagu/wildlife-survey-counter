"""Local stdio MCP server exposing the elk classification tools to subscription-backed CLI runs."""

from __future__ import annotations

import sys
from pathlib import Path

from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp import Image as MCPImage
from mcp.types import ToolAnnotations

from wildlife_counter import classify as impl


def main():
    c = impl.Classification.from_source(Path(sys.argv[1]).resolve())
    server = FastMCP('elk-classify')
    local = ToolAnnotations(destructiveHint=False, openWorldHint=False)

    @server.tool(annotations=local)
    def get_batches() -> dict:
        """List batches of numbered elk to classify, the classes, and which batches remain."""
        return impl.get_batches(c)

    @server.tool(annotations=local)
    def view_batch(batch: str) -> MCPImage:
        """View one batch: a magnified full-resolution crop with a numbered tag beside each elk."""
        return MCPImage(data=impl.view_batch(c, batch), format='jpeg')

    @server.tool(annotations=local)
    def view_animal(animal: int) -> MCPImage:
        """Zoom on a single numbered elk to check its head and antlers."""
        return MCPImage(data=impl.view_animal(c, animal), format='jpeg')

    @server.tool(annotations=local)
    def record_classes(batch: str, labels: list[impl.Label]) -> str:
        """Store exactly one class for every elk in a viewed batch (id, cls, optional short note)."""
        return impl.record_classes(c, batch, labels)

    @server.tool(annotations=local)
    def finish(summary: str) -> dict:
        """Finish once every batch is recorded; summarize any systematic uncertainty briefly."""
        return impl.finish(c, summary)

    server.run()


if __name__ == '__main__':
    main()
