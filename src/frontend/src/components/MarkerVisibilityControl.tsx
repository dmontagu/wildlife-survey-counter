import { useAppState, useDispatch } from '../state'
import type { MarkerVisibilityMode } from '../types'
import ShortcutKey from './ShortcutKey'
import { Button } from './ui/button'

const MARKER_VISIBILITY_OPTIONS: { id: MarkerVisibilityMode; label: string }[] = [
  { id: 'visible', label: 'Show' },
  { id: 'dimmed', label: 'Fade' },
  { id: 'hidden', label: 'Hide' },
]

export default function MarkerVisibilityControl() {
  const state = useAppState()
  const dispatch = useDispatch()

  if (!state.image) return null

  return (
    <div className="pointer-events-auto absolute bottom-3 left-3 z-20 hidden lg:block">
      <div className="w-[15.25rem] max-w-[calc(100vw-1.5rem)] rounded-2xl border border-white/10 bg-slate-950/72 p-2.5 shadow-[0_16px_40px_rgba(0,0,0,0.35)] backdrop-blur-md supports-[backdrop-filter]:bg-slate-950/58">
        <div className="mb-2 flex items-center justify-between gap-2 px-1">
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-100">Markers</div>
          <div className="inline-flex items-center gap-1.5 text-[11px] text-slate-300/80">
            <ShortcutKey shortcut="V" compact />
            <span>to cycle</span>
          </div>
        </div>
        <div className="flex gap-2">
          {MARKER_VISIBILITY_OPTIONS.map((option) => (
            <Button
              key={option.id}
              variant={state.markerVisibility === option.id ? 'default' : 'outline'}
              size="sm"
              onClick={() => dispatch({ type: 'SET_MARKER_VISIBILITY', visibility: option.id })}
              className={[
                'h-9 flex-1 rounded-xl border-white/10 bg-slate-900/65 text-slate-50 shadow-none backdrop-blur-sm',
                'hover:bg-slate-800/90',
                state.markerVisibility === option.id
                  ? 'border-primary/40 bg-primary text-primary-foreground hover:bg-primary/90'
                  : '',
              ].join(' ')}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  )
}
