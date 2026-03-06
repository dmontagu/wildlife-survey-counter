import type { RecentImageRecord } from '../types'
import { imageStorageId, LS_RECENT_IMAGES_KEY } from './storage'

const MAX_RECENT_IMAGES = 24

function sortRecentImages(images: RecentImageRecord[]): RecentImageRecord[] {
  return [...images].sort((a, b) => Date.parse(b.lastOpenedAt) - Date.parse(a.lastOpenedAt))
}

function normalizeRecord(raw: unknown): RecentImageRecord | null {
  if (typeof raw !== 'object' || raw === null) return null
  const data = raw as Record<string, unknown>
  const filename = typeof data.filename === 'string' ? data.filename : null
  const basePath = typeof data.basePath === 'string' ? data.basePath : null
  if (!filename || basePath === null) return null

  return {
    id: typeof data.id === 'string' ? data.id : imageStorageId(filename, basePath),
    filename,
    displayName: typeof data.displayName === 'string' ? data.displayName : null,
    basePath,
    width: typeof data.width === 'number' ? data.width : 0,
    height: typeof data.height === 'number' ? data.height : 0,
    lastOpenedAt: typeof data.lastOpenedAt === 'string' ? data.lastOpenedAt : new Date().toISOString(),
    counted: typeof data.counted === 'number' ? data.counted : 0,
    ignored: typeof data.ignored === 'number' ? data.ignored : 0,
    bulls: typeof data.bulls === 'number' ? data.bulls : 0,
    spikes: typeof data.spikes === 'number' ? data.spikes : 0,
  }
}

export function readRecentImages(): RecentImageRecord[] {
  try {
    const stored = localStorage.getItem(LS_RECENT_IMAGES_KEY)
    if (!stored) return []
    const parsed = JSON.parse(stored)
    if (!Array.isArray(parsed)) return []
    return sortRecentImages(parsed.map(normalizeRecord).filter((item): item is RecentImageRecord => item !== null))
  } catch {
    return []
  }
}

export function writeRecentImages(images: RecentImageRecord[]): RecentImageRecord[] {
  const trimmed = sortRecentImages(images).slice(0, MAX_RECENT_IMAGES)
  localStorage.setItem(LS_RECENT_IMAGES_KEY, JSON.stringify(trimmed))
  return trimmed
}

export function upsertRecentImage(record: RecentImageRecord): RecentImageRecord[] {
  const existing = readRecentImages()
  const next = existing.filter((item) => item.id !== record.id)
  next.unshift(record)
  return writeRecentImages(next)
}
