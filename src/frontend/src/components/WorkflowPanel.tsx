import { ChevronDownIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { LS_WORKFLOW_PANEL_COLLAPSED_KEY } from '../lib/storage'
import ShortcutKey from './ShortcutKey'

export default function WorkflowPanel() {
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false
    return window.localStorage.getItem(LS_WORKFLOW_PANEL_COLLAPSED_KEY) === 'true'
  })

  useEffect(() => {
    window.localStorage.setItem(LS_WORKFLOW_PANEL_COLLAPSED_KEY, collapsed ? 'true' : 'false')
  }, [collapsed])

  return (
    <section
      className={[
        'pointer-events-auto absolute top-3 left-3 z-20 rounded-2xl border border-white/10 bg-slate-950/72 p-3 shadow-[0_16px_40px_rgba(0,0,0,0.35)] backdrop-blur-md supports-[backdrop-filter]:bg-slate-950/58',
        collapsed ? 'min-w-[11rem]' : 'w-[18.5rem] max-w-[calc(100vw-1.5rem)]',
      ].join(' ')}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-100">How to Use</div>
        <button
          type="button"
          onClick={() => setCollapsed((current) => !current)}
          className="inline-flex items-center gap-1 rounded-lg px-1.5 py-1 text-[11px] text-slate-300/80 transition-colors hover:bg-white/5 hover:text-slate-100"
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand workflow help' : 'Collapse workflow help'}
        >
          <span>{collapsed ? 'Show' : 'Hide'}</span>
          <ChevronDownIcon
            className={['size-3.5 transition-transform', collapsed ? '-rotate-90' : 'rotate-0'].join(' ')}
          />
        </button>
      </div>
      {!collapsed ? (
        <ul className="mt-2 list-disc space-y-2 pl-4 text-[12px] leading-5 text-slate-200/90 marker:text-slate-400">
          <li>Click empty space to add a point.</li>
          <li>
            Click a point to select it, then use <ShortcutKey shortcut="E" compact /> or the Class buttons to relabel
            it.
          </li>
          <li>
            Drag empty space to pan. Hold <ShortcutKey shortcut="Shift" compact /> and drag to select several points.
          </li>
          <li>
            Press <ShortcutKey shortcut="Backspace" compact /> to delete selected points. Export Results saves the
            review image and JSON.
          </li>
        </ul>
      ) : null}
    </section>
  )
}
