import { CheckIcon } from 'lucide-react'
import { useMemo } from 'react'
import { ELK_CATEGORY_OPTIONS } from '../config'
import { isIgnoredAnnotation } from '../lib/annotations'
import { useAppState, useDispatch } from '../state'
import ShortcutKey from './ShortcutKey'
import { Button } from './ui/button'

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

  const displayCategory = state.selectedIds.size > 0 ? selectedCategory : state.activeCategory

  if (!state.image) return null

  return (
    <div className="pointer-events-none absolute inset-0 z-20">
      <div className="absolute top-3 right-3 pointer-events-auto">
        <PaletteCard
          title="Class"
          hint={
            <span className="inline-flex items-center gap-1.5">
              <ShortcutKey shortcut="E" compact />
              <span>to cycle</span>
            </span>
          }
          widthClass="w-[21rem]"
        >
          {ELK_CATEGORY_OPTIONS.map((option) => (
            <FloatingActionButton
              key={option.id}
              active={displayCategory === option.id}
              label={option.label}
              title={option.shortcut ? `${option.description} (${option.shortcut.toUpperCase()})` : option.description}
              onClick={() => {
                if (state.selectedIds.size > 0) {
                  dispatch({
                    type: 'SET_CATEGORY',
                    ids: [...state.selectedIds],
                    category: option.id,
                  })
                  return
                }
                dispatch({ type: 'SET_ACTIVE_CATEGORY', category: option.id })
              }}
            />
          ))}

          {state.selectedIds.size > 0 ? (
            <div className="basis-full space-y-2 border-t border-white/10 px-1 pt-2">
              <div className="rounded-xl bg-white/5 px-2.5 py-2 text-[11px] leading-4 text-slate-200/90">
                This changes the class of the {state.selectedIds.size} selected marker
                {state.selectedIds.size === 1 ? '' : 's'}. Changing the class or moving a marker also confirms it.
              </div>
              <div className="flex items-center justify-between gap-3 rounded-xl bg-white/5 px-2.5 py-2 text-[11px] text-slate-200/90">
                <span>
                  Delete {state.selectedIds.size} selected marker{state.selectedIds.size === 1 ? '' : 's'}
                </span>
                <ShortcutKey shortcut="Backspace" compact />
              </div>
              {confirmableSelectionCount > 0 ? (
                <Button
                  size="sm"
                  onClick={() => dispatch({ type: 'CONFIRM', ids: [...state.selectedIds] })}
                  className="h-auto w-full items-center justify-between gap-3 rounded-xl border border-amber-400/25 bg-amber-500/12 px-3 py-2.5 text-left text-[11px] font-medium text-amber-50 shadow-none hover:bg-amber-500/18"
                >
                  <span className="min-w-0 inline-flex items-center gap-2">
                    <CheckIcon className="size-3.5 shrink-0" />
                    <span className="leading-4">
                      Confirm {confirmableSelectionCount} unconfirmed marker
                      {confirmableSelectionCount === 1 ? '' : 's'}
                    </span>
                  </span>
                  <ShortcutKey shortcut="C" compact />
                </Button>
              ) : null}
            </div>
          ) : (
            <div className="basis-full border-t border-white/10 px-1 pt-2 text-[11px] leading-4 text-slate-300/80">
              This sets the class for the next new point. Click a marker first if you want to relabel an existing one.
            </div>
          )}
        </PaletteCard>
      </div>
    </div>
  )
}

function PaletteCard({
  title,
  hint,
  widthClass = 'w-[19rem]',
  children,
}: {
  title: string
  hint?: React.ReactNode
  widthClass?: string
  children: React.ReactNode
}) {
  return (
    <section
      className={[
        widthClass,
        'max-w-[calc(100vw-1.5rem)] rounded-2xl border border-white/10 bg-slate-950/72 p-2.5 shadow-[0_16px_40px_rgba(0,0,0,0.35)] backdrop-blur-md',
        'supports-[backdrop-filter]:bg-slate-950/58',
      ].join(' ')}
    >
      <div className="mb-2 flex items-baseline justify-between gap-2 px-1">
        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-100">{title}</div>
        {hint ? <div className="text-[11px] text-slate-300/80">{hint}</div> : null}
      </div>

      <div className="flex flex-wrap justify-end gap-2">{children}</div>
    </section>
  )
}

function FloatingActionButton({
  active = false,
  disabled = false,
  icon: Icon,
  label,
  title,
  onClick,
}: {
  active?: boolean
  disabled?: boolean
  icon?: React.ComponentType<{ className?: string }>
  label: string
  title?: string
  onClick: () => void
}) {
  return (
    <Button
      variant={active ? 'default' : 'outline'}
      size="sm"
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={[
        'h-9 gap-2 rounded-xl border-white/10 bg-slate-900/65 text-slate-50 shadow-none backdrop-blur-sm',
        'hover:bg-slate-800/90',
        active ? 'border-primary/40 bg-primary text-primary-foreground hover:bg-primary/90' : '',
      ].join(' ')}
    >
      {Icon ? <Icon className="size-3.5" /> : null}
      <span>{label}</span>
    </Button>
  )
}
