import { FolderOpenIcon, HistoryIcon, ImageIcon, PencilLineIcon, SparklesIcon, Trash2Icon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FEEDBACK_FORM_URL, UPDATES_FORM_ACTION, UPDATES_FORM_EMAIL_FIELD } from '../config'
import { getBrowserImageFromBasePath, isBrowserImageBasePath } from '../lib/browser-images'
import { displayNameFor, normalizeDisplayName } from '../lib/image-names'
import type { RecentImageRecord, RecentImagesSortMode, ServerImageRecord } from '../types'
import BrandMark from './BrandMark'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'

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

const QUICK_STEPS = [
  'Open a survey photo or drag one into the page.',
  'Click empty space to add points, then click a point to relabel or adjust it.',
  'Export a review JPG and JSON when you are finished.',
]

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

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-8 lg:px-6">
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
          <section className="rounded-2xl border border-border bg-card/70 p-6 shadow-sm">
            <div className="max-w-2xl space-y-4">
              <div className="space-y-2">
                <div className="inline-flex items-center gap-3 rounded-full border border-border/80 bg-background/50 px-3 py-2">
                  <BrandMark className="size-8 shrink-0" title="Wildlife Survey Counter" />
                  <h1 className="text-2xl font-semibold text-foreground sm:text-3xl">Wildlife Survey Counter</h1>
                </div>
                <p className="max-w-xl text-sm leading-6 text-muted-foreground">
                  Review aerial survey photos, place markers quickly, and track bulls and spikes.
                </p>
              </div>

              <div
                onDragOver={(event) => {
                  event.preventDefault()
                  setDragOver(true)
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={[
                  'cursor-pointer rounded-2xl border-2 border-dashed px-6 py-10 transition-colors',
                  dragOver ? 'border-primary bg-primary/10' : 'border-border bg-background/50 hover:border-primary/50',
                ].join(' ')}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleFileChange}
                  className="hidden"
                />

                {uploading ? (
                  <div className="space-y-3 text-center">
                    <div className="mx-auto size-9 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
                    <p className="text-sm text-muted-foreground">Preparing your image…</p>
                  </div>
                ) : (
                  <div className="space-y-4 text-center">
                    <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-primary/12 text-primary">
                      <FolderOpenIcon className="size-5" />
                    </div>
                    <div className="space-y-1">
                      <p className="text-base font-medium text-foreground">Drop a survey photo here</p>
                      <p className="text-sm text-muted-foreground">or click to browse from this computer</p>
                    </div>
                  </div>
                )}
              </div>

              <div className="grid gap-3 md:grid-cols-3">
                {QUICK_STEPS.map((step, index) => (
                  <div key={step} className="rounded-xl border border-border bg-background/50 px-4 py-3">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-primary">
                      Step {index + 1}
                    </div>
                    <p className="mt-2 text-sm leading-5 text-muted-foreground">{step}</p>
                  </div>
                ))}
              </div>

              <section className="rounded-xl border border-primary/25 bg-primary/8 p-4">
                <div className="space-y-3">
                  <p className="text-sm leading-6 text-foreground">
                    Built by{' '}
                    <a
                      href="mailto:davwmont@gmail.com"
                      className="font-medium text-primary underline-offset-4 hover:underline"
                    >
                      David Montague
                    </a>{' '}
                    in Bozeman, Montana.
                  </p>
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="rounded-xl border border-border/70 bg-background/45 p-3">
                      <div className="text-sm font-medium text-foreground">Feedback</div>
                      <p className="mt-1 text-sm leading-6 text-muted-foreground">
                        Share bugs, feature requests, workflow notes, or any other feedback.
                      </p>
                      <div className="mt-3">
                        <Button asChild size="sm">
                          <a href={FEEDBACK_FORM_URL} target="_blank" rel="noreferrer">
                            Give feedback
                          </a>
                        </Button>
                      </div>
                    </div>

                    <div className="rounded-xl border border-border/70 bg-background/45 p-3">
                      <div className="text-sm font-medium text-foreground">Updates</div>
                      <p className="mt-1 text-sm leading-6 text-muted-foreground">
                        Leave your email if you want to be notified about updates to the tool.
                      </p>
                      <form
                        action={UPDATES_FORM_ACTION}
                        method="post"
                        target="updates-signup-target"
                        className="mt-3 flex min-w-0 flex-col gap-2 sm:flex-row"
                        onSubmit={() => {
                          setUpdatesSubmitted(true)
                          setUpdatesEmail('')
                        }}
                      >
                        <label htmlFor="home-notify-email" className="sr-only">
                          Email for updates
                        </label>
                        <input
                          id="home-notify-email"
                          type="email"
                          name={UPDATES_FORM_EMAIL_FIELD}
                          autoComplete="email"
                          required
                          placeholder="Email for updates"
                          value={updatesEmail}
                          onChange={(event) => {
                            setUpdatesEmail(event.target.value)
                            if (updatesSubmitted) setUpdatesSubmitted(false)
                          }}
                          className="h-9 min-w-0 rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none ring-offset-background placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:flex-1"
                        />
                        <input type="hidden" name="fvv" value="1" />
                        <input type="hidden" name="pageHistory" value="0" />
                        <Button type="submit" size="sm" className="sm:shrink-0">
                          Notify me
                        </Button>
                      </form>
                      <iframe title="" name="updates-signup-target" className="hidden" />
                      {updatesSubmitted ? (
                        <p className="mt-2 text-xs leading-5 text-primary">Thanks. I’ll use this only for tool updates.</p>
                      ) : null}
                    </div>
                  </div>
                </div>
              </section>

              <section className="rounded-xl border border-amber-500/25 bg-amber-500/8 p-4">
                <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-300">
                  Storage and Privacy
                </div>
                <ul className="mt-2 space-y-2 text-sm leading-6 text-muted-foreground">
                  <li>Work is saved in this browser.</li>
                  <li>That means it stays private to this browser and is not visible on the internet.</li>
                  <li>
                    If you switch browsers, clear browser storage, or lose access to this device, you can lose access
                    to saved labeling work.
                  </li>
                  <li>If any of this changes in the future, this page will say so clearly.</li>
                </ul>
              </section>
            </div>
          </section>

          <aside className="space-y-6 rounded-2xl border border-border bg-card/70 p-6 shadow-sm">
            <section className="space-y-3">
              <div className="flex items-center gap-2">
                <HistoryIcon className="size-4 text-primary" />
                <h2 className="text-sm font-semibold text-foreground">Recent Work</h2>
              </div>

              {recentImages.length > 0 ? (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                      Sort
                    </span>
                    <Button
                      size="xs"
                      variant={recentImagesSort === 'last-edited' ? 'secondary' : 'outline'}
                      onClick={() => onChangeRecentImagesSort('last-edited')}
                    >
                      Last edited
                    </Button>
                    <Button
                      size="xs"
                      variant={recentImagesSort === 'alphabetical' ? 'secondary' : 'outline'}
                      onClick={() => onChangeRecentImagesSort('alphabetical')}
                    >
                      Alphabetical
                    </Button>
                  </div>
                </>
              ) : null}

              {recentImages.length > 0 ? (
                <div className="space-y-3">
                  <div className="max-h-[42rem] space-y-3 overflow-y-auto pr-1">
                    {recentImages.map((record) => (
                      <div key={record.id} className="rounded-xl border border-border bg-background/45 p-3">
                        <div className="flex items-start gap-3">
                          <button
                            type="button"
                            onClick={() => onOpenRecentImage(record)}
                            className="relative mt-0.5 flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-background/70"
                            aria-label={`Open ${displayNameFor(record)}`}
                          >
                            {previewUrls[record.id] ? (
                              <img
                                src={previewUrls[record.id]}
                                alt=""
                                className="h-full w-full object-cover"
                                loading="lazy"
                                draggable={false}
                              />
                            ) : (
                              <ImageIcon className="size-5 text-muted-foreground/70" />
                            )}
                          </button>

                          <div className="min-w-0 flex-1">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <p className="truncate text-sm font-medium text-foreground">{displayNameFor(record)}</p>
                                <p className="mt-1 text-xs text-muted-foreground">
                                  {record.counted} counted, {record.bulls} bulls, {record.spikes} spikes
                                </p>
                                <p className="mt-1 text-xs text-muted-foreground">
                                  {record.width} × {record.height}px
                                </p>
                                <p className="mt-1 text-xs text-muted-foreground">
                                  Last edited {new Date(record.lastEditedAt).toLocaleString()}
                                </p>
                              </div>
                              <Button
                                size="icon-xs"
                                variant="ghost"
                                onClick={() => void handleDeleteClick(record)}
                                aria-label={`Delete ${displayNameFor(record)} from recent work`}
                              >
                                <Trash2Icon className="size-3.5" />
                              </Button>
                            </div>

                            <div className="mt-3 flex flex-wrap gap-2">
                              <Button size="xs" variant="outline" onClick={() => onOpenRecentImage(record)}>
                                Open
                              </Button>
                              <Button size="xs" variant="outline" onClick={() => openRenameDialog(record)}>
                                <PencilLineIcon className="size-3.5" />
                                Rename
                              </Button>
                              <Button size="xs" variant="secondary" onClick={() => void onExportRecent(record)}>
                                Export
                              </Button>
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="flex justify-end">
                    <Button size="sm" variant="outline" onClick={onExportAllJson}>
                      Export saved annotations
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="text-sm leading-6 text-muted-foreground">
                  Images you open in this browser will show up here with their saved counts and classifications.
                </p>
              )}
            </section>

            {sampleImages.length > 0 && (
              <section className="space-y-3">
                <div className="flex items-center gap-2">
                  <SparklesIcon className="size-4 text-muted-foreground" />
                  <h2 className="text-sm font-semibold text-foreground">Dev Samples</h2>
                </div>
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
        </div>
      </div>

      <Dialog open={pendingDelete !== null} onOpenChange={(open) => (!open ? setPendingDelete(null) : null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete this recent item?</DialogTitle>
            <DialogDescription>
              {pendingDelete
                ? `${displayNameFor(pendingDelete)} has saved annotations. Deleting it will remove the saved image and annotation data from this browser.`
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
              Delete Item
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
          <input
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || !pendingRename) return
              event.preventDefault()
              onRenameRecentImage(pendingRename, normalizeDisplayName(draftName, pendingRename.filename))
              setPendingRename(null)
            }}
            className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground outline-none ring-offset-background placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
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
              Save Name
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
