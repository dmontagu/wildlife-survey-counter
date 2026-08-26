import type { Dispatch } from 'react'
import { useEffect } from 'react'
import { KEYS, nextCategory, previousCategory } from '../config'
import type { Action, AnnotationCategory } from '../types'

function normalizedKey(value: string): string {
  return value.length === 1 ? value.toLowerCase() : value
}

function matchesKey(
  e: KeyboardEvent,
  binding: string | string[] | { key: string; meta?: boolean; shift?: boolean },
): boolean {
  if (Array.isArray(binding)) {
    return binding.some((k) => normalizedKey(e.key) === normalizedKey(k) && !e.metaKey && !e.ctrlKey)
  }
  if (typeof binding === 'string') {
    return normalizedKey(e.key) === normalizedKey(binding) && !e.metaKey && !e.ctrlKey
  }
  const meta = e.metaKey || e.ctrlKey
  return (
    normalizedKey(e.key) === normalizedKey(binding.key) && meta === !!binding.meta && e.shiftKey === !!binding.shift
  )
}

export function useKeyboard(
  dispatch: Dispatch<Action>,
  dirty: React.MutableRefObject<boolean>,
  activeCategory: AnnotationCategory,
) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Don't capture when typing in inputs
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return

      if (matchesKey(e, KEYS.cycleMarkerVisibility)) {
        dispatch({ type: 'CYCLE_MARKER_VISIBILITY' })
        dirty.current = true
        return
      }

      if (matchesKey(e, KEYS.confirmSelection)) {
        dispatch({ type: 'CONFIRM', ids: [] })
        return
      }

      if (matchesKey(e, KEYS.unconfirmSelection)) {
        dispatch({ type: 'UNCONFIRM', ids: [] })
        return
      }

      if (matchesKey(e, KEYS.deleteOrReject)) {
        dispatch({ type: 'DELETE_OR_REJECT', ids: [] })
        return
      }

      if (matchesKey(e, KEYS.undo)) {
        e.preventDefault()
        dispatch({ type: 'UNDO' })
        return
      }

      if (matchesKey(e, KEYS.redo)) {
        e.preventDefault()
        dispatch({ type: 'REDO' })
        return
      }

      // Also match Cmd+Y for redo
      if (e.key === 'y' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        dispatch({ type: 'REDO' })
        return
      }

      if (matchesKey(e, KEYS.selectAll)) {
        e.preventDefault()
        dispatch({ type: 'SELECT_ALL_VISIBLE' })
        return
      }

      if (matchesKey(e, KEYS.deselect)) {
        dispatch({ type: 'DESELECT_ALL' })
        return
      }

      if (matchesKey(e, KEYS.help)) {
        dispatch({ type: 'TOGGLE_HELP' })
        return
      }

      if (matchesKey(e, KEYS.cycleCategory)) {
        // Shift reverses the cycle direction.
        const category = e.shiftKey ? previousCategory(activeCategory) : nextCategory(activeCategory)
        dispatch({ type: 'SET_ACTIVE_CATEGORY', category })
        return
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [activeCategory, dirty, dispatch])
}
