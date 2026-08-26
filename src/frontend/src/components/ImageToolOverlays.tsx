import { CheckIcon } from 'lucide-react'
import { useMemo } from 'react'
import { categoryOption, ELK_CATEGORY_OPTIONS } from '../config'
import { isIgnoredAnnotation } from '../lib/annotations'
import { useAppState, useDispatch } from '../state'
import ShortcutKey from './ShortcutKey'
import { Button } from './ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip'

export default function ImageToolOverlays() {
  const state = useAppState()
  const dispatch = useDispatch()

  const selectedAnnotations = useMemo(
    () => state.annotations.filter((annotation) => state.selectedIds.has(annotation.id)),
    [state.annotations, state.selectedIds],
  )

  const selectedCategory = useMemo(() => {
    if (selectedAnnotations.length === 0) return undefined
    const first = selectedAnnotations[0]!.category
    return selectedAnnotations.every((annotation) => annotation.category === first) ? first : undefined
  }, [selectedAnnotations])
  const confirmableSelectionCount = useMemo(
    () =>
      selectedAnnotations.filter(
        (annotation) => !isIgnoredAnnotation(annotation) && annotation.reviewStatus === 'unconfirmed',
      ).length,
    [selectedAnnotations],
  )

  const selectionCount = state.selectedIds.size
  const displayCategory = selectionCount > 0 ? selectedCategory : state.activeCategory
  const displayOption = displayCategory ? categoryOption(displayCategory) : undefined

  if (!state.image) return null

  return (
    <div className="pointer-events-none absolute inset-0 z-20">
      <div className="pointer-events-auto absolute top-2 right-2 sm:top-3 sm:right-3">
        <OverlayPanel
          title="Class"
          hint={
            <span className="inline-flex items-center gap-1.5">
              <ShortcutKey shortcut="E" compact />
              <span>to cycle</span>
            </span>
          }
        >
          <div className="flex flex-wrap gap-1 sm:gap-1.5">
            <TooltipProvider delayDuration={150}>
              {ELK_CATEGORY_OPTIONS.map((option) => (
                <ClassButton
                  key={option.id}
                  active={displayCategory === option.id}
                  label={option.shortLabel}
                  ariaLabel={option.label}
                  tooltip={`${option.label} (${option.shortcut.toUpperCase()})${option.hint ? ` — ${option.hint}` : ''}`}
                  onClick={() => {
                    if (selectionCount > 0) {
                      dispatch({ type: 'SET_CATEGORY', ids: [...state.selectedIds], category: option.id })
                      return
                    }
                    dispatch({ type: 'SET_ACTIVE_CATEGORY', category: option.id })
                  }}
                />
              ))}
            </TooltipProvider>
          </div>

          <div className="hidden items-center gap-2 text-xs text-muted-foreground sm:flex">
            {displayOption ? (
              <>
                <span
                  aria-hidden="true"
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: displayOption.color }}
                />
                <span className="text-foreground">{displayOption.label}</span>
                <span>{selectionCount > 0 ? 'selected' : 'for new markers'}</span>
              </>
            ) : (
              <span>Mixed classes — pick one to apply it to the selection</span>
            )}
          </div>

          {selectionCount > 0 ? (
            <div
              className={[
                'space-y-2 border-t border-border pt-1.5 text-xs text-muted-foreground sm:pt-2',
                // On narrow viewports only the Confirm button survives, so skip the block when it has nothing to show.
                confirmableSelectionCount > 0 ? '' : 'hidden sm:block',
              ].join(' ')}
            >
              <p className="hidden leading-5 sm:block">
                Picking a class applies it to the {selectionCount} selected marker{selectionCount === 1 ? '' : 's'} and
                confirms {selectionCount === 1 ? 'it' : 'them'}.
              </p>
              <div className="hidden items-center justify-between gap-3 sm:flex">
                <span>Delete selected</span>
                <ShortcutKey shortcut="Backspace" compact />
              </div>
              {confirmableSelectionCount > 0 ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => dispatch({ type: 'CONFIRM', ids: [...state.selectedIds] })}
                  className="w-full justify-between border-unconfirmed/40 bg-unconfirmed/10 text-foreground hover:bg-unconfirmed/20"
                >
                  <span className="inline-flex min-w-0 items-center gap-2">
                    <CheckIcon className="size-3.5 shrink-0" />
                    <span>Confirm {confirmableSelectionCount} unconfirmed</span>
                  </span>
                  <ShortcutKey shortcut="Enter" compact />
                </Button>
              ) : null}
            </div>
          ) : null}
        </OverlayPanel>
      </div>
    </div>
  )
}

/** Shared chrome for the floating panels over the image (class palette, marker visibility, zoom speed). */
export function OverlayPanel({
  title,
  hint,
  className = 'w-auto sm:w-72',
  children,
}: {
  title: string
  hint?: React.ReactNode
  className?: string
  children: React.ReactNode
}) {
  return (
    <section
      className={[
        className,
        'max-w-[calc(100vw-1rem)] space-y-1.5 rounded-lg border border-border bg-popover/85 p-1.5 shadow-md backdrop-blur-md sm:space-y-2 sm:p-3',
      ].join(' ')}
    >
      <div className="hidden items-baseline justify-between gap-3 sm:flex">
        <h2 className="text-xs font-semibold text-foreground">{title}</h2>
        {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
      </div>
      {children}
    </section>
  )
}

function ClassButton({
  active,
  label,
  ariaLabel,
  tooltip,
  onClick,
}: {
  active: boolean
  label: string
  ariaLabel: string
  tooltip: string
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={active ? 'default' : 'outline'}
          size="sm"
          aria-label={ariaLabel}
          aria-pressed={active}
          onClick={onClick}
          className="w-8 px-0 font-semibold sm:w-9"
        >
          {label}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tooltip}</TooltipContent>
    </Tooltip>
  )
}
