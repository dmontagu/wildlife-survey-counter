const DIVISIONS: { amount: number; unit: Intl.RelativeTimeFormatUnit }[] = [
  { amount: 60, unit: 'second' },
  { amount: 60, unit: 'minute' },
  { amount: 24, unit: 'hour' },
  { amount: 7, unit: 'day' },
  { amount: 4.34524, unit: 'week' },
  { amount: 12, unit: 'month' },
  { amount: Number.POSITIVE_INFINITY, unit: 'year' },
]

const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

/** "just now", "3 hours ago", "yesterday", "2 months ago". Returns the input unchanged if it is not a date. */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const time = new Date(iso).getTime()
  if (Number.isNaN(time)) return iso
  let duration = (time - now) / 1000
  if (Math.abs(duration) < 45) return 'just now'
  for (const division of DIVISIONS) {
    if (Math.abs(duration) < division.amount) return formatter.format(Math.round(duration), division.unit)
    duration /= division.amount
  }
  return formatter.format(Math.round(duration), 'year')
}
