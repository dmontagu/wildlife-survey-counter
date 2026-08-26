import { ELK_CATEGORY_OPTIONS } from '../config'
import type { CategorySummaryKey, RecentImageRecord, RecentImagesSortMode } from '../types'
import { displayNameFor } from './image-names'
import { imageStorageId, LS_RECENT_IMAGES_KEY } from './storage'

function compareByName(a: RecentImageRecord, b: RecentImageRecord): number {
  return displayNameFor(a).localeCompare(displayNameFor(b), undefined, {
    numeric: true,
    sensitivity: 'base',
  })
}

export function sortRecentImages(
  images: RecentImageRecord[],
  sortMode: RecentImagesSortMode = 'last-edited',
): RecentImageRecord[] {
  return [...images].sort((a, b) => {
    if (sortMode === 'alphabetical') {
      return compareByName(a, b) || Date.parse(b.lastEditedAt) - Date.parse(a.lastEditedAt)
    }

    return Date.parse(b.lastEditedAt) - Date.parse(a.lastEditedAt) || compareByName(a, b)
  })
}

function normalizeRecord(raw: unknown): RecentImageRecord | null {
  if (typeof raw !== 'object' || raw === null) return null
  const data = raw as Record<string, unknown>
  const filename = typeof data.filename === 'string' ? data.filename : null
  const basePath = typeof data.basePath === 'string' ? data.basePath : null
  if (!filename || basePath === null) return null

  // Records saved before a class existed simply lack its field; treat that as zero.
  const categoryCounts = {} as Record<CategorySummaryKey, number>
  for (const option of ELK_CATEGORY_OPTIONS) {
    const value = data[option.summaryKey]
    categoryCounts[option.summaryKey] = typeof value === 'number' ? value : 0
  }

  return {
    ...categoryCounts,
    id: typeof data.id === 'string' ? data.id : imageStorageId(filename, basePath),
    filename,
    displayName: typeof data.displayName === 'string' ? data.displayName : null,
    basePath,
    width: typeof data.width === 'number' ? data.width : 0,
    height: typeof data.height === 'number' ? data.height : 0,
    lastEditedAt:
      typeof data.lastEditedAt === 'string'
        ? data.lastEditedAt
        : typeof data.lastOpenedAt === 'string'
          ? data.lastOpenedAt
          : new Date().toISOString(),
    counted: typeof data.counted === 'number' ? data.counted : 0,
    ignored: typeof data.ignored === 'number' ? data.ignored : 0,
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
  const sorted = sortRecentImages(images)
  localStorage.setItem(LS_RECENT_IMAGES_KEY, JSON.stringify(sorted))
  return sorted
}

export function upsertRecentImage(record: RecentImageRecord): RecentImageRecord[] {
  const existing = readRecentImages()
  const next = existing.filter((item) => item.id !== record.id)
  next.unshift(record)
  return writeRecentImages(next)
}

export function removeRecentImage(id: string): RecentImageRecord[] {
  return writeRecentImages(readRecentImages().filter((item) => item.id !== id))
}
