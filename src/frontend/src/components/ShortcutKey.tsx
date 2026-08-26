interface ShortcutKeyProps {
  shortcut: string
  compact?: boolean
}

const SHORTCUT_LABELS: Record<string, string> = {
  '\u2318': 'Cmd',
  '\u2325': 'Option',
  '\u2303': 'Ctrl',
  '\u21e7': 'Shift',
  '^': 'Ctrl',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Escape: 'Esc',
}

function normalizeShortcutLabel(shortcut: string): string {
  const trimmed = shortcut.trim()
  const mapped = SHORTCUT_LABELS[trimmed] ?? trimmed
  return mapped.length === 1 && /[a-z]/i.test(mapped) ? mapped.toUpperCase() : mapped
}

export default function ShortcutKey({ shortcut, compact = false }: ShortcutKeyProps) {
  const label = normalizeShortcutLabel(shortcut)
  const isSingleCharacter = label.length === 1

  return (
    <kbd
      className={[
        'inline-flex h-5 items-center justify-center whitespace-nowrap rounded-[4px] border border-border bg-background/80 px-1.5 font-mono text-[11px] font-medium leading-none text-muted-foreground',
        compact ? (isSingleCharacter ? 'min-w-5' : '') : isSingleCharacter ? 'min-w-6' : '',
      ].join(' ')}
    >
      {label}
    </kbd>
  )
}

export function ShortcutSequence({ shortcut, compact = false }: ShortcutKeyProps) {
  const parts = shortcut
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)

  return (
    <span className="inline-flex items-center gap-1">
      {parts.map((part, index) => (
        <span key={`${shortcut}-${part}-${index}`} className="inline-flex items-center gap-1">
          {index > 0 ? <span className="text-[11px] text-muted-foreground/80">+</span> : null}
          <ShortcutKey shortcut={part} compact={compact} />
        </span>
      ))}
    </span>
  )
}
