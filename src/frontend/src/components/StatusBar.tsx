import { ChevronDownIcon, DownloadIcon } from 'lucide-react'
import { CATEGORY_COLORS, REVIEW_STATUS_COLORS } from '../colors'
import { summarizeAnnotations } from '../lib/annotations'
import { useAppState } from '../state'
import BuildInfo from './BuildInfo'
import { Button } from './ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu'

export default function StatusBar({
  onExportAnnotatedImage,
  onExportJsonOnly,
  onExportOriginalImage,
  onExportResults,
}: {
  onExportAnnotatedImage: () => void
  onExportJsonOnly: () => void
  onExportOriginalImage: () => void
  onExportResults: () => void
}) {
  const state = useAppState()
  const summary = summarizeAnnotations(state.annotations)

  if (!state.image) {
    return (
      <div className="border-t border-border bg-card/70 px-3 py-2 text-sm text-muted-foreground">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3">
          <span>Ready to label a new image.</span>
          <div className="flex items-center gap-4">
            <span>Recent work is saved in this browser.</span>
            <BuildInfo />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="border-t border-border bg-card/70 px-3 py-2 text-sm">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-5 gap-y-2">
        <StatusChip badge="All" color="#F5F5F0" label="Total Counted" value={summary.counted} />
        <StatusChip badge="U" color={REVIEW_STATUS_COLORS.unconfirmed} label="Unconfirmed" value={summary.unconfirmed} />
        <StatusChip badge="B" color={CATEGORY_COLORS.bull} label="Bulls" value={summary.bulls} />
        <StatusChip badge="S" color={CATEGORY_COLORS.spike} label="Spikes" value={summary.spikes} />
        <span className="text-muted-foreground tabular-nums">{state.selectedIds.size} selected</span>
        <span className="text-muted-foreground tabular-nums">
          {state.image.width} × {state.image.height}px
        </span>
        <div className="flex-1" />
        <BuildInfo className="mr-1" />
        <div className="flex items-center">
          <Button size="sm" onClick={onExportResults} className="h-7 rounded-r-none rounded-l-lg px-2.5 text-xs">
            <DownloadIcon className="size-3.5" />
            Export Results
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                className="h-7 rounded-l-none rounded-r-lg border-l border-white/15 px-2 text-xs shadow-none hover:bg-primary/90"
                aria-label="More export options"
              >
                <ChevronDownIcon className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem onSelect={onExportAnnotatedImage}>Export Annotated Image</DropdownMenuItem>
              <DropdownMenuItem onSelect={onExportOriginalImage}>Export Original Image</DropdownMenuItem>
              <DropdownMenuItem onSelect={onExportJsonOnly}>Export JSON Only</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  )
}

function StatusChip({ badge, color, label, value }: { badge?: string; color: string; label: string; value: number }) {
  return (
    <div className="flex items-center gap-2">
      {badge ? (
        <span
          className="inline-flex h-4 min-w-4 items-center justify-center rounded border px-1 text-[10px] font-semibold leading-none"
          style={{ borderColor: color, color }}
        >
          {badge}
        </span>
      ) : (
        <span className="size-2 rounded-full" style={{ backgroundColor: color }} />
      )}
      <span className="text-muted-foreground">{label}</span>
      <span className="font-semibold tabular-nums text-foreground">{value}</span>
    </div>
  )
}
