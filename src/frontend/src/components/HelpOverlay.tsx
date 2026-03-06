import { platformModifier } from '../platform'
import { useAppState, useDispatch } from '../state'
import { ShortcutSequence } from './ShortcutKey'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'

const GROUPS = [
  {
    title: 'Workspace',
    items: [
      ['Open image', 'Use the Open Image button or drag a file into the window'],
      ['Home', 'Return to the landing page and recent work list'],
      ['Export Results', 'Download the review JPG and JSON together'],
      ['Advanced', 'Turn bbox creation on only when you need box-level annotation'],
    ],
  },
  {
    title: 'Tools',
    items: [
      ['A', 'Switch to Add mode'],
      ['Esc', 'Switch to Select mode and clear the selection'],
      ['Delete', 'Remove the selected marker'],
      [`${platformModifier}+Z`, 'Undo the last change'],
      [`${platformModifier}+Shift+Z`, 'Redo the last undone change'],
    ],
  },
  {
    title: 'Classification',
    items: [
      ['C', 'Set new markers to cow and update the current selection'],
      ['B', 'Set new markers to bull and update the current selection'],
      ['S', 'Set new markers to spike and update the current selection'],
      ['Double-click', 'Zoom to a marker and select it'],
    ],
  },
  {
    title: 'Navigation',
    items: [
      ['Scroll', 'Pan the image'],
      [`${platformModifier}+Scroll`, 'Zoom around the cursor'],
      ['Space + Move', 'Pan without clicking'],
      ['V (hold)', 'Hide markers temporarily'],
      ['?', 'Toggle this help panel'],
    ],
  },
] as const

export default function HelpOverlay() {
  const state = useAppState()
  const dispatch = useDispatch()

  return (
    <Dialog open={state.helpVisible} onOpenChange={() => dispatch({ type: 'TOGGLE_HELP' })}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>How to label an image</DialogTitle>
          <DialogDescription>
            The toolbar shows the main shortcuts directly on the buttons. This panel is the longer reference.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-6 md:grid-cols-2">
          {GROUPS.map((group) => (
            <section key={group.title} className="space-y-3">
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                {group.title}
              </h3>
              <div className="space-y-2">
                {group.items.map(([shortcut, description]) => (
                  <div
                    key={`${group.title}-${shortcut}`}
                    className="flex items-start justify-between gap-4 rounded-lg border border-border bg-background/45 px-3 py-2"
                  >
                    <ShortcutSequence shortcut={shortcut} compact />
                    <span className="text-sm leading-5 text-muted-foreground">{description}</span>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
