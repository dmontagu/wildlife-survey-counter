import { ImageIcon, MoreHorizontalIcon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CONTACT_EMAIL,
  categoryOption,
  DEFAULT_CATEGORY,
  ELK_CATEGORY_OPTIONS,
  FEEDBACK_FORM_URL,
  UPDATES_FORM_ACTION,
  UPDATES_FORM_EMAIL_FIELD,
} from '../config'
import { getBrowserImageFromBasePath, isBrowserImageBasePath } from '../lib/browser-images'
import { formatRelativeTime } from '../lib/format-time'
import { displayNameFor, normalizeDisplayName } from '../lib/image-names'
import type { RecentImageRecord, RecentImagesSortMode, ServerImageRecord } from '../types'
import BrandMark from './BrandMark'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import { Input } from './ui/input'

interface WelcomeScreenProps {
  notice?: string | null
  recentImages: RecentImageRecord[]
  recentImagesSort: RecentImagesSortMode
  sampleImages: ServerImageRecord[]
  onChangeRecentImagesSort: (sortMode: RecentImagesSortMode) => void
  onExportAllJson: () => void
  onDeleteRecentImage: (record: RecentImageRecord) => Promise<void>
  onExportRecent: (record: RecentImageRecord) => void
  onOpenImageFile: (file: File) => Promise<void>
  onOpenRecentImage: (record: RecentImageRecord) => void
  onRenameRecentImage: (record: RecentImageRecord, name: string | null) => void
  onOpenSampleImage: (record: ServerImageRecord) => void
}

/** Numbered because it really is a sequence: the order is the workflow. */
const QUICK_STEPS = [
  'Open a survey photo, or drag one into this page.',
  'Click each animal to place a marker. Click a marker again to reclassify or move it.',
  'Export the annotated JPG and JSON when the count is done.',
]

const LINK_CLASS =
  'font-medium text-foreground underline decoration-primary/60 underline-offset-4 hover:decoration-primary'

function singular(label: string): string {
  return label.endsWith('s') && !label.endsWith('ss') ? label.slice(0, -1) : label
}

/** "2 bulls · 1 spike" — the non-default classes that have a count. The total is shown separately. */
function classBreakdown(record: RecentImageRecord): string {
  const parts: string[] = []
  for (const option of ELK_CATEGORY_OPTIONS) {
    if (option.id === DEFAULT_CATEGORY) continue
    const value = record[option.summaryKey]
    if (value > 0) parts.push(`${value} ${value === 1 ? singular(option.countLabel) : option.countLabel}`)
  }
  if (parts.length > 0) return parts.join(' · ')
  return record.counted > 0 ? `all ${categoryOption(DEFAULT_CATEGORY).countLabel}` : 'no markers yet'
}

export default function WelcomeScreen({
  recentImages,
  recentImagesSort,
  sampleImages,
  onChangeRecentImagesSort,
  onExportAllJson,
  onDeleteRecentImage,
  onExportRecent,
  onOpenImageFile,
  onOpenRecentImage,
  onRenameRecentImage,
  onOpenSampleImage,
}: WelcomeScreenProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({})
  const [pendingDelete, setPendingDelete] = useState<RecentImageRecord | null>(null)
  const [pendingRename, setPendingRename] = useState<RecentImageRecord | null>(null)
  const [draftName, setDraftName] = useState('')
  const [updatesEmail, setUpdatesEmail] = useState('')
  const [updatesSubmitted, setUpdatesSubmitted] = useState(false)
  const previewCandidates = useMemo(() => recentImages.slice(0, 48), [recentImages])

  useEffect(() => {
    let cancelled = false
    const objectUrls: string[] = []

    async function loadPreviews() {
      const entries = await Promise.all(
        previewCandidates.map(async (record) => {
          if (!isBrowserImageBasePath(record.basePath)) {
            return [record.id, `${record.basePath}${record.filename}`] as const
          }

          try {
            const file = await getBrowserImageFromBasePath(record.basePath)
            if (!file) return [record.id, null] as const
            const url = URL.createObjectURL(file)
            objectUrls.push(url)
            return [record.id, url] as const
          } catch {
            return [record.id, null] as const
          }
        }),
      )

      if (cancelled) {
        for (const url of objectUrls) URL.revokeObjectURL(url)
        return
      }

      setPreviewUrls(
        Object.fromEntries(
          entries.filter((entry): entry is readonly [string, string] => typeof entry[1] === 'string'),
        ),
      )
    }

    void loadPreviews()

    return () => {
      cancelled = true
      for (const url of objectUrls) URL.revokeObjectURL(url)
    }
  }, [previewCandidates])

  const handleFile = useCallback(
    async (file: File) => {
      if (!file.type.startsWith('image/')) return
      setUploading(true)
      try {
        await onOpenImageFile(file)
      } finally {
        setUploading(false)
      }
    },
    [onOpenImageFile],
  )

  const handleFileChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0]
      if (file) void handleFile(file)
      event.target.value = ''
    },
    [handleFile],
  )

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      setDragOver(false)
      const file = event.dataTransfer.files[0]
      if (file) void handleFile(file)
    },
    [handleFile],
  )

  const handleDeleteClick = useCallback(
    async (record: RecentImageRecord) => {
      if (record.counted > 0 || record.ignored > 0) {
        setPendingDelete(record)
        return
      }
      await onDeleteRecentImage(record)
    },
    [onDeleteRecentImage],
  )

  const openRenameDialog = useCallback((record: RecentImageRecord) => {
    setDraftName(displayNameFor(record))
    setPendingRename(record)
  }, [])

  const openFilePicker = useCallback(() => fileInputRef.current?.click(), [])

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-6xl px-5 py-10 lg:px-8 lg:py-12">
        <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,26rem)] lg:grid-rows-[auto_1fr] lg:gap-x-16 lg:gap-y-10">
          <section className="min-w-0 space-y-10 lg:col-start-1 lg:row-start-1">
            <header className="space-y-3">
              <div className="flex items-center gap-3">
                <BrandMark className="size-9 shrink-0" title="Wildlife Survey Counter" />
                <h1 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
                  Wildlife Survey Counter
                </h1>
              </div>
              <p className="max-w-xl text-base leading-7 text-muted-foreground">
                Count elk in aerial survey photos. Mark each animal, classify it, and export the tally.
              </p>
            </header>

            <div className="space-y-6">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleFileChange}
                className="hidden"
                tabIndex={-1}
              />
              <button
                type="button"
                onDragOver={(event) => {
                  event.preventDefault()
                  setDragOver(true)
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={openFilePicker}
                className={[
                  'block w-full cursor-pointer rounded-lg border border-dashed px-6 py-12 text-center outline-none transition-colors',
                  'focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  dragOver
                    ? 'border-primary bg-primary/10'
                    : 'border-muted-foreground/40 hover:border-primary/70 hover:bg-card',
                ].join(' ')}
              >
                {uploading ? (
                  <span className="block space-y-3">
                    <span className="mx-auto block size-8 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
                    <span className="block text-sm text-muted-foreground">Preparing your image…</span>
                  </span>
                ) : (
                  <span className="block space-y-1">
                    <span className="block text-base font-medium text-foreground">Drop a survey photo here</span>
                    <span className="block text-sm text-muted-foreground">or click to browse this computer</span>
                  </span>
                )}
              </button>

              <ol className="space-y-2 text-sm leading-6 text-muted-foreground">
                {QUICK_STEPS.map((step, index) => (
                  <li key={step} className="flex gap-4">
                    <span className="w-4 shrink-0 text-right font-medium text-primary tabular-nums">{index + 1}</span>
                    <span>{step}</span>
                  </li>
                ))}
              </ol>
            </div>
          </section>

          <aside className="min-w-0 space-y-10 lg:col-start-2 lg:row-span-2 lg:row-start-1">
            <section className="space-y-3">
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="text-sm font-semibold text-foreground">Recent work</h2>
                {recentImages.length > 1 ? (
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <span className="mr-1">Sort</span>
                    <Button
                      size="xs"
                      variant={recentImagesSort === 'last-edited' ? 'secondary' : 'ghost'}
                      onClick={() => onChangeRecentImagesSort('last-edited')}
                    >
                      Last edited
                    </Button>
                    <Button
                      size="xs"
                      variant={recentImagesSort === 'alphabetical' ? 'secondary' : 'ghost'}
                      onClick={() => onChangeRecentImagesSort('alphabetical')}
                    >
                      A–Z
                    </Button>
                  </div>
                ) : null}
              </div>

              {recentImages.length > 0 ? (
                <div className="space-y-3">
                  <ul className="max-h-[40rem] divide-y divide-border overflow-y-auto border-y border-border">
                    {recentImages.map((record) => (
                      <RecentWorkRow
                        key={record.id}
                        record={record}
                        previewUrl={previewUrls[record.id]}
                        onOpen={() => onOpenRecentImage(record)}
                        onRename={() => openRenameDialog(record)}
                        onExport={() => void onExportRecent(record)}
                        onDelete={() => void handleDeleteClick(record)}
                      />
                    ))}
                  </ul>

                  <div className="flex justify-end">
                    <Button size="sm" variant="outline" onClick={onExportAllJson}>
                      Export all saved annotations
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="text-sm leading-6 text-muted-foreground">
                  Photos you open in this browser will show up here with their saved counts.
                </p>
              )}
            </section>

            {sampleImages.length > 0 && (
              <section className="space-y-3">
                <h2 className="text-sm font-semibold text-foreground">Dev samples</h2>
                <div className="flex flex-wrap gap-2">
                  {sampleImages.map((sample) => (
                    <Button key={sample.url} size="xs" variant="outline" onClick={() => onOpenSampleImage(sample)}>
                      {sample.filename}
                    </Button>
                  ))}
                </div>
              </section>
            )}
          </aside>

          <div className="min-w-0 space-y-8 lg:col-start-1 lg:row-start-2">
            <section className="space-y-2 border-t border-border pt-8 text-sm leading-6 text-muted-foreground">
              <h2 className="font-semibold text-foreground">Your work stays in this browser</h2>
              <p>
                Photos and counts are saved in this browser only. They stay private to this device and are not visible
                on the internet.
              </p>
              <p>
                Clearing browser storage, switching browsers, or losing this device can lose saved work, so export the
                JSON when a count matters. If any of this changes, this page will say so clearly.
              </p>
            </section>

            <footer className="space-y-4 border-t border-border pt-8 text-sm leading-6 text-muted-foreground">
              <p>
                I’m David Montague, a developer in Bozeman, Montana, and I build and maintain this tool. If it’s useful
                to you, or if something gets in your way, I’d like to hear about it:{' '}
                <a href={`mailto:${CONTACT_EMAIL}`} className={LINK_CLASS}>
                  email me
                </a>{' '}
                or{' '}
                <a href={FEEDBACK_FORM_URL} target="_blank" rel="noreferrer" className={LINK_CLASS}>
                  send feedback
                </a>
                .
              </p>

              <form
                action={UPDATES_FORM_ACTION}
                method="post"
                target="updates-signup-target"
                className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3"
                onSubmit={() => {
                  setUpdatesSubmitted(true)
                  setUpdatesEmail('')
                }}
              >
                <label htmlFor="home-notify-email" className="shrink-0">
                  Get an email when the tool changes
                </label>
                <Input
                  id="home-notify-email"
                  type="email"
                  name={UPDATES_FORM_EMAIL_FIELD}
                  autoComplete="email"
                  required
                  placeholder="you@example.gov"
                  value={updatesEmail}
                  onChange={(event) => {
                    setUpdatesEmail(event.target.value)
                    if (updatesSubmitted) setUpdatesSubmitted(false)
                  }}
                  className="h-8 sm:max-w-64"
                />
                <input type="hidden" name="fvv" value="1" />
                <input type="hidden" name="pageHistory" value="0" />
                <Button type="submit" variant="outline" size="sm" className="sm:shrink-0">
                  Notify me
                </Button>
              </form>
              <iframe title="Signup form submission target" name="updates-signup-target" className="hidden" />
              {updatesSubmitted ? (
                <p className="text-xs text-primary">Thanks — this address is only used for tool updates.</p>
              ) : null}
            </footer>
          </div>
        </div>
      </div>

      <Dialog open={pendingDelete !== null} onOpenChange={(open) => (!open ? setPendingDelete(null) : null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete this image from recent work?</DialogTitle>
            <DialogDescription>
              {pendingDelete
                ? `${displayNameFor(pendingDelete)} has ${pendingDelete.counted} saved marker${pendingDelete.counted === 1 ? '' : 's'}. Deleting removes the image and its markers from this browser. Export first if you want to keep them.`
                : ''}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                if (!pendingDelete) return
                await onDeleteRecentImage(pendingDelete)
                setPendingDelete(null)
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={pendingRename !== null} onOpenChange={(open) => (!open ? setPendingRename(null) : null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rename image</DialogTitle>
            <DialogDescription>
              {pendingRename ? `Choose a clearer name for ${pendingRename.filename}.` : ''}
            </DialogDescription>
          </DialogHeader>
          <Input
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || !pendingRename) return
              event.preventDefault()
              onRenameRecentImage(pendingRename, normalizeDisplayName(draftName, pendingRename.filename))
              setPendingRename(null)
            }}
            placeholder="Image name"
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingRename(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (!pendingRename) return
                onRenameRecentImage(pendingRename, normalizeDisplayName(draftName, pendingRename.filename))
                setPendingRename(null)
              }}
            >
              Save name
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function RecentWorkRow({
  record,
  previewUrl,
  onOpen,
  onRename,
  onExport,
  onDelete,
}: {
  record: RecentImageRecord
  previewUrl: string | undefined
  onOpen: () => void
  onRename: () => void
  onExport: () => void
  onDelete: () => void
}) {
  const name = displayNameFor(record)
  const edited = new Date(record.lastEditedAt)

  return (
    <li className="flex items-center gap-2 py-3">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${name}`}
        className="group flex min-w-0 flex-1 items-center gap-3 rounded-md text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <span className="relative h-11 w-16 shrink-0 overflow-hidden rounded-md bg-muted">
          {previewUrl ? (
            <img src={previewUrl} alt="" className="h-full w-full object-cover" loading="lazy" draggable={false} />
          ) : (
            <ImageIcon className="absolute inset-0 m-auto size-4 text-muted-foreground/60" />
          )}
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground underline-offset-4 decoration-muted-foreground/50 group-hover:underline">
            {name}
          </span>
          <span
            className="mt-0.5 block truncate text-xs text-muted-foreground"
            title={`${record.width} × ${record.height}px · edited ${edited.toLocaleString()}`}
          >
            {classBreakdown(record)} · {formatRelativeTime(record.lastEditedAt)}
          </span>
        </span>

        <span className="shrink-0 pl-2 text-right">
          <span className="block text-lg font-semibold leading-none text-foreground tabular-nums">
            {record.counted}
          </span>
          <span className="mt-1 block text-xs text-muted-foreground">elk</span>
        </span>
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon-xs"
            variant="ghost"
            className="shrink-0 text-muted-foreground"
            aria-label={`More actions for ${name}`}
          >
            <MoreHorizontalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem onSelect={onOpen}>Open</DropdownMenuItem>
          <DropdownMenuItem onSelect={onRename}>Rename…</DropdownMenuItem>
          <DropdownMenuItem onSelect={onExport}>Export annotations</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={onDelete}>
            Delete from this browser
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  )
}
