import { ChevronDownIcon, CrosshairIcon, MousePointer2Icon } from 'lucide-react'
import type React from 'react'
import { useMemo, useState } from 'react'
import { ELK_CATEGORY_OPTIONS } from '../config'
import { useAppState, useDispatch } from '../state'
import ShortcutKey, { ShortcutSequence } from './ShortcutKey'
import { Button } from './ui/button'

export default function ImageToolOverlays() {
  const state = useAppState()
  const dispatch = useDispatch()
  const [expandedPanel, setExpandedPanel] = useState<'mode' | 'classify' | null>(null)

  const selectedAnnotations = useMemo(
    () => state.annotations.filter((annotation) => state.selectedIds.has(annotation.id)),
    [state.annotations, state.selectedIds],
  )

  const selectedCategory = useMemo(() => {
    if (selectedAnnotations.length === 0) return undefined
    const first = selectedAnnotations[0]?.category ?? null
    return selectedAnnotations.every((annotation) => annotation.category === first) ? first : undefined
  }, [selectedAnnotations])
  const activeCategoryOption = useMemo(
    () => ELK_CATEGORY_OPTIONS.find((option) => option.id === state.activeCategory) ?? ELK_CATEGORY_OPTIONS[0]!,
    [state.activeCategory],
  )

  if (!state.image) return null

  return (
    <div className="pointer-events-none absolute inset-0 z-20">
      <div className="absolute top-3 left-3 pointer-events-auto">
        <PaletteCard
          title="Mode"
          hint="Switch tools quickly"
          panelId="mode"
          expanded={expandedPanel === 'mode'}
          description="Add places markers. Select moves them and lets you review or classify them."
          onToggle={(panelId) => setExpandedPanel((current) => (current === panelId ? null : panelId))}
        >
          <FloatingActionButton
            active={state.interactionMode === 'select'}
            icon={MousePointer2Icon}
            label="Select"
            shortcut="Esc"
            onClick={() => {
              dispatch({ type: 'SET_INTERACTION_MODE', mode: 'select' })
              dispatch({ type: 'DESELECT_ALL' })
            }}
          />
          <FloatingActionButton
            active={state.interactionMode === 'add'}
            icon={CrosshairIcon}
            label="Add"
            shortcut="A"
            onClick={() => dispatch({ type: 'SET_INTERACTION_MODE', mode: 'add' })}
          />
        </PaletteCard>
      </div>

      <div className="absolute top-3 right-3 pointer-events-auto">
        <PaletteCard
          title="Classify"
          hint={`New markers: ${activeCategoryOption.label}`}
          panelId="classify"
          expanded={expandedPanel === 'classify'}
          description={
            selectedAnnotations.length > 0
              ? `New markers use this label, and clicking a category also updates the ${selectedAnnotations.length} selected marker${selectedAnnotations.length === 1 ? '' : 's'}.`
              : 'New markers use this label. Select a marker only if you want to reclassify one you already placed.'
          }
          onToggle={(panelId) => setExpandedPanel((current) => (current === panelId ? null : panelId))}
          align="end"
        >
          {ELK_CATEGORY_OPTIONS.map((option) => (
            <FloatingActionButton
              key={option.label}
              active={state.activeCategory === option.id}
              label={option.label}
              shortcut={option.shortcut}
              onClick={() => {
                dispatch({ type: 'SET_ACTIVE_CATEGORY', category: option.id })
                if (state.selectedIds.size > 0 && selectedCategory !== option.id) {
                  dispatch({
                    type: 'SET_CATEGORY',
                    ids: [...state.selectedIds],
                    category: option.id,
                  })
                }
              }}
            />
          ))}
        </PaletteCard>
      </div>
    </div>
  )
}

function PaletteCard({
  title,
  hint,
  panelId,
  expanded,
  description,
  onToggle,
  align = 'start',
  children,
}: {
  title: string
  hint: string
  panelId: 'mode' | 'classify'
  expanded: boolean
  description: string
  onToggle: (panelId: 'mode' | 'classify') => void
  align?: 'start' | 'end'
  children: React.ReactNode
}) {
  return (
    <section
      className={[
        'w-[19rem] max-w-[calc(100vw-1.5rem)] rounded-2xl border border-white/10 bg-slate-950/72 p-2.5 shadow-[0_16px_40px_rgba(0,0,0,0.35)] backdrop-blur-md',
        'supports-[backdrop-filter]:bg-slate-950/58',
      ].join(' ')}
    >
      <div
        className={[
          'mb-2 flex items-baseline gap-2 px-1',
          align === 'end' ? 'justify-end text-right' : 'justify-between',
        ].join(' ')}
      >
        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-100">{title}</div>
        <div className="text-[11px] text-slate-300/80">{hint}</div>
      </div>

      <div className={['flex flex-wrap gap-2', align === 'end' ? 'justify-end' : 'justify-start'].join(' ')}>
        {children}
      </div>

      <button
        type="button"
        onClick={() => onToggle(panelId)}
        className={[
          'mt-2 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[11px] text-slate-300/80 transition-colors hover:bg-white/5 hover:text-slate-100',
          align === 'end' ? 'justify-end text-right' : 'justify-between',
        ].join(' ')}
      >
        <span>{expanded ? 'Hide details' : 'Show details'}</span>
        <ChevronDownIcon
          className={['size-3.5 transition-transform', expanded ? 'rotate-180' : 'rotate-0'].join(' ')}
        />
      </button>

      {expanded && (
        <div
          className={[
            'mt-1 border-t border-white/10 px-2 pt-2 text-xs leading-5 text-slate-200/85 whitespace-normal break-words',
            align === 'end' ? 'text-right' : 'text-left',
          ].join(' ')}
        >
          {description}
        </div>
      )}
    </section>
  )
}

function FloatingActionButton({
  active = false,
  disabled = false,
  icon: Icon,
  label,
  shortcut,
  onClick,
}: {
  active?: boolean
  disabled?: boolean
  icon?: React.ComponentType<{ className?: string }>
  label: string
  shortcut: string
  onClick: () => void
}) {
  return (
    <Button
      variant={active ? 'default' : 'outline'}
      size="sm"
      disabled={disabled}
      onClick={onClick}
      className={[
        'h-9 gap-2 rounded-xl border-white/10 bg-slate-900/65 text-slate-50 shadow-none backdrop-blur-sm',
        'hover:bg-slate-800/90',
        active ? 'border-primary/40 bg-primary text-primary-foreground hover:bg-primary/90' : '',
      ].join(' ')}
    >
      {Icon ? <Icon className="size-3.5" /> : null}
      <span>{label}</span>
      {shortcut.includes('+') ? (
        <ShortcutSequence shortcut={shortcut} compact />
      ) : (
        <ShortcutKey shortcut={shortcut} compact />
      )}
    </Button>
  )
}
