import { useAppState, useDispatch } from '../state'
import type { MarkerVisibilityMode } from '../types'
import { OverlayPanel } from './ImageToolOverlays'
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
      <OverlayPanel
        title="Markers"
        className="w-60"
        hint={
          <span className="inline-flex items-center gap-1.5">
            <ShortcutKey shortcut="V" compact />
            <span>to cycle</span>
          </span>
        }
      >
        <div className="flex gap-1.5">
          {MARKER_VISIBILITY_OPTIONS.map((option) => (
            <Button
              key={option.id}
              variant={state.markerVisibility === option.id ? 'default' : 'outline'}
              size="sm"
              aria-pressed={state.markerVisibility === option.id}
              onClick={() => dispatch({ type: 'SET_MARKER_VISIBILITY', visibility: option.id })}
              className="flex-1"
            >
              {option.label}
            </Button>
          ))}
        </div>
      </OverlayPanel>
    </div>
  )
}
