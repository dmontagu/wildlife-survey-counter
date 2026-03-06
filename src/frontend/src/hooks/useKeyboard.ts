import type { Dispatch } from 'react'
import { useEffect } from 'react'
import { KEYS } from '../config'
import type { Action } from '../types'

function matchesKey(
  e: KeyboardEvent,
  binding: string | string[] | { key: string; meta?: boolean; shift?: boolean },
): boolean {
  if (Array.isArray(binding)) {
    return binding.some((k) => e.key === k && !e.metaKey && !e.ctrlKey)
  }
  if (typeof binding === 'string') {
    return e.key === binding && !e.metaKey && !e.ctrlKey
  }
  const meta = e.metaKey || e.ctrlKey
  return e.key === binding.key && meta === !!binding.meta && e.shiftKey === !!binding.shift
}

export function useKeyboard(
  dispatch: Dispatch<Action>,
  annotationsHidden: React.MutableRefObject<boolean>,
  dirty: React.MutableRefObject<boolean>,
) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Don't capture when typing in inputs
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return

      if (matchesKey(e, KEYS.hideAnnotations)) {
        annotationsHidden.current = true
        dirty.current = true
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

      if (matchesKey(e, KEYS.setSelectMode)) {
        e.preventDefault()
        dispatch({ type: 'SET_INTERACTION_MODE', mode: 'select' })
        dispatch({ type: 'DESELECT_ALL' })
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

      if (matchesKey(e, KEYS.setAddMode)) {
        dispatch({ type: 'SET_INTERACTION_MODE', mode: 'add' })
        return
      }

      if (matchesKey(e, KEYS.setCowCategory)) {
        dispatch({ type: 'SET_ACTIVE_CATEGORY', category: null })
        return
      }

      if (matchesKey(e, KEYS.setBullCategory)) {
        dispatch({ type: 'SET_ACTIVE_CATEGORY', category: 'bull' })
        return
      }

      if (matchesKey(e, KEYS.setSpikeCategory)) {
        dispatch({ type: 'SET_ACTIVE_CATEGORY', category: 'spike' })
        return
      }
    }

    function onKeyUp(e: KeyboardEvent) {
      if (e.key === 'v') {
        annotationsHidden.current = false
        dirty.current = true
      }
    }

    function onBlur() {
      annotationsHidden.current = false
      dirty.current = true
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [dispatch, annotationsHidden, dirty])
}
