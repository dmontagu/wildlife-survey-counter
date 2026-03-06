import { DownloadIcon } from 'lucide-react'
import { CATEGORY_COLORS } from '../colors'
import { summarizeAnnotations } from '../lib/annotations'
import { useAppState } from '../state'
import { Button } from './ui/button'

export default function StatusBar({ onExportResults }: { onExportResults: () => void }) {
  const state = useAppState()
  const summary = summarizeAnnotations(state.annotations)

  if (!state.image) {
    return (
      <div className="border-t border-border bg-card/70 px-3 py-2 text-sm text-muted-foreground">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3">
          <span>Ready to label a new image.</span>
          <span>Recent work is saved in this browser.</span>
        </div>
      </div>
    )
  }

  return (
    <div className="border-t border-border bg-card/70 px-3 py-2 text-sm">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-5 gap-y-2">
        <StatusChip color={CATEGORY_COLORS.default} label="Counted" value={summary.counted} />
        <StatusChip badge="B" color={CATEGORY_COLORS.bull} label="Bulls" value={summary.bulls} />
        <StatusChip badge="S" color={CATEGORY_COLORS.spike} label="Spikes" value={summary.spikes} />
        <StatusChip color={CATEGORY_COLORS.ignored} label="Ignored" value={summary.ignored} />
        <span className="text-muted-foreground tabular-nums">
          {state.image.width} × {state.image.height}px
        </span>
        <div className="flex-1" />
        <Button size="sm" onClick={onExportResults} className="h-7 rounded-lg px-2.5 text-xs">
          <DownloadIcon className="size-3.5" />
          Export Results
        </Button>
        <span className="text-muted-foreground tabular-nums">{state.selectedIds.size} selected</span>
      </div>
    </div>
  )
}

function StatusChip({ badge, color, label, value }: { badge?: string; color: string; label: string; value: number }) {
  return (
    <div className="flex items-center gap-2">
      {badge ? (
        <span
          className="inline-flex h-4 min-w-4 items-center justify-center rounded border text-[10px] font-semibold leading-none"
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
