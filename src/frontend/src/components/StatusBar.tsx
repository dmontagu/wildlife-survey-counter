import { ChevronDownIcon, DownloadIcon } from 'lucide-react'
import { REVIEW_STATUS_COLORS } from '../colors'
import { ELK_CATEGORY_OPTIONS } from '../config'
import { summarizeAnnotations } from '../lib/annotations'
import { useAppState } from '../state'
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
          <span>Work is saved in this browser only.</span>
        </div>
      </div>
    )
  }

  return (
    <div className="border-t border-border bg-card/70 px-3 py-1.5 text-sm sm:py-2">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-1.5 sm:gap-y-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1.5 sm:gap-x-5 sm:gap-y-2">
          <StatusChip badge="All" color="#F5F5F0" label="Total Counted" value={summary.counted} />
          {summary.unconfirmed > 0 ? (
            <StatusChip color={REVIEW_STATUS_COLORS.unconfirmed} label="Unconfirmed" value={summary.unconfirmed} />
          ) : null}
          {ELK_CATEGORY_OPTIONS.map((option) => (
            <StatusChip
              key={option.id}
              badge={option.shortLabel}
              color={option.color}
              label={option.statusLabel ?? option.label}
              value={summary[option.summaryKey]}
            />
          ))}
          <span className="whitespace-nowrap text-muted-foreground tabular-nums">
            {state.selectedIds.size} selected
          </span>
          <span className="hidden whitespace-nowrap text-muted-foreground tabular-nums sm:inline">
            {state.image.width} × {state.image.height}px
          </span>
        </div>
        <div className="flex w-full shrink-0 items-center gap-3 sm:w-auto">
          <div className="flex w-full items-center sm:w-auto">
            <Button
              size="sm"
              onClick={onExportResults}
              className="h-7 flex-1 rounded-r-none rounded-l-md px-2.5 text-xs sm:flex-none"
            >
              <DownloadIcon className="size-3.5" />
              Export Results
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  className="h-7 rounded-l-none rounded-r-md border-l border-primary-foreground/20 px-2 text-xs shadow-none hover:bg-primary/90"
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
    </div>
  )
}

function StatusChip({ badge, color, label, value }: { badge?: string; color: string; label: string; value: number }) {
  return (
    <div className="flex items-center gap-1.5 sm:gap-2">
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
      <span className="hidden whitespace-nowrap text-muted-foreground sm:inline">{label}</span>
      <span className="font-semibold tabular-nums text-foreground">{value}</span>
    </div>
  )
}
