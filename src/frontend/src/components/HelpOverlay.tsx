import { ELK_CATEGORY_OPTIONS } from '../config'
import { isMac, platformModifier } from '../platform'
import { useAppState, useDispatch } from '../state'
import { ShortcutSequence } from './ShortcutKey'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'

const SHARED_GROUPS = [
  {
    title: 'Workspace',
    items: [
      ['Open image', 'Use the Open Image button or drag a file into the window'],
      ['Home', 'Return to the landing page and recent work list'],
      ['Export Results', 'Download the review JPG and JSON together'],
      ['Advanced', 'Turn on the bbox tool only when needed, then hold Alt and drag to draw a box'],
    ],
  },
  {
    title: 'Tools',
    items: [
      ['Esc', 'Clear the current selection'],
      ['C', 'Confirm the selected marker or markers as reviewed'],
      ['U', 'Mark the selected marker or markers as unconfirmed'],
      ['Backspace', 'Delete the selected marker'],
      ['Shift+Drag', 'Select markers in a box'],
      [`Shift+${platformModifier}+Drag`, 'Select markers in a box and confirm them immediately'],
      [`${platformModifier}+Z`, 'Undo the last change'],
      [`${platformModifier}+Shift+Z`, 'Redo the last undone change'],
    ],
  },
  {
    title: 'Classification',
    items: [
      ['E', 'Cycle the selected marker label, or set the class for the next new marker when nothing is selected'],
      ...ELK_CATEGORY_OPTIONS.filter((option) => option.shortcut !== null).map(
        (option) => [option.shortcut!.toUpperCase(), option.description] as const,
      ),
    ],
  },
] as const

function navigationItems() {
  if (isMac) {
    return [
      ['Click empty space', 'Add a new marker when nothing is selected'],
      ['Drag empty space', 'Pan the image'],
      ['Scroll', 'Pan the image'],
      [`${platformModifier}+Scroll`, 'Zoom around the cursor'],
      [`${platformModifier}+Drag`, 'Pan while holding the modifier key'],
      ['Space + Move', 'Temporarily pan without clicking'],
      ['V', 'Cycle markers between visible, faded, and hidden'],
      ['?', 'Toggle this help panel'],
    ] as const
  }

  return [
    ['Click empty space', 'Add a new marker when nothing is selected'],
    ['Drag empty space', 'Pan the image'],
    ['Scroll', 'Zoom around the cursor'],
    [`${platformModifier}+Drag`, 'Pan while holding the modifier key'],
    ['Space + Move', 'Temporarily pan without clicking'],
    ['V', 'Cycle markers between visible, faded, and hidden'],
    ['?', 'Toggle this help panel'],
  ] as const
}

export default function HelpOverlay() {
  const state = useAppState()
  const dispatch = useDispatch()
  const groups = [
    ...SHARED_GROUPS,
    {
      title: 'Navigation',
      items: navigationItems(),
    },
  ]

  return (
    <Dialog open={state.helpVisible} onOpenChange={() => dispatch({ type: 'TOGGLE_HELP' })}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>How to label an image</DialogTitle>
          <DialogDescription>
            The toolbar shows the main shortcuts directly on the buttons. This panel is the longer reference.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-6 overflow-y-auto pr-1 md:grid-cols-2">
          {groups.map((group) => (
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
