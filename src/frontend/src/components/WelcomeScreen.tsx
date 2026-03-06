import { FolderOpenIcon, HistoryIcon, ShieldCheckIcon, SparklesIcon } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import { displayNameFor } from '../lib/image-names'
import type { RecentImageRecord, ServerImageRecord } from '../types'
import { Button } from './ui/button'

interface WelcomeScreenProps {
  notice?: string | null
  recentImages: RecentImageRecord[]
  sampleImages: ServerImageRecord[]
  onExportRecent: (record: RecentImageRecord) => void
  onOpenImageFile: (file: File) => Promise<void>
  onOpenRecentImage: (record: RecentImageRecord) => void
  onOpenSampleImage: (record: ServerImageRecord) => void
}

const QUICK_STEPS = [
  'Open a survey photo or drag one into the page.',
  'Use Add to place markers, then Select to move or classify them.',
  'Export a review JPG and JSON when you are finished.',
]

export default function WelcomeScreen({
  recentImages,
  sampleImages,
  onExportRecent,
  onOpenImageFile,
  onOpenRecentImage,
  onOpenSampleImage,
}: WelcomeScreenProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState(false)

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

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-8 lg:px-6">
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
          <section className="rounded-2xl border border-border bg-card/70 p-6 shadow-sm">
            <div className="max-w-2xl space-y-4">
              <div className="space-y-2">
                <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                  Manual Labeling Workspace
                </div>
                <h1 className="text-3xl font-semibold text-foreground">Wildlife Survey Counter</h1>
                <p className="max-w-xl text-sm leading-6 text-muted-foreground">
                  Review aerial survey photos, place markers quickly, and flag special elk like bulls or spikes without
                  relying on automation.
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
                    <p className="text-xs leading-5 text-muted-foreground">
                      Images are re-encoded in the browser before they are saved so EXIF location metadata is stripped
                      by default.
                    </p>
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
            </div>
          </section>

          <aside className="space-y-6 rounded-2xl border border-border bg-card/70 p-6 shadow-sm">
            <section className="space-y-3">
              <div className="flex items-center gap-2">
                <HistoryIcon className="size-4 text-primary" />
                <h2 className="text-sm font-semibold text-foreground">Recent Work</h2>
              </div>

              {recentImages.length > 0 ? (
                <div className="space-y-3">
                  {recentImages.slice(0, 8).map((record) => (
                    <div key={record.id} className="rounded-xl border border-border bg-background/45 p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-foreground">{displayNameFor(record)}</p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {record.counted} counted, {record.bulls} bulls, {record.spikes} spikes
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            Last opened {new Date(record.lastOpenedAt).toLocaleString()}
                          </p>
                        </div>
                        <div className="flex shrink-0 gap-2">
                          <Button size="xs" variant="outline" onClick={() => onOpenRecentImage(record)}>
                            Open
                          </Button>
                          <Button size="xs" variant="secondary" onClick={() => void onExportRecent(record)}>
                            Export
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}
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

            <section className="rounded-xl border border-border bg-background/45 p-4">
              <div className="flex items-center gap-2">
                <ShieldCheckIcon className="size-4 text-primary" />
                <h2 className="text-sm font-semibold text-foreground">Workflow Notes</h2>
              </div>
              <ul className="mt-3 space-y-2 text-sm leading-6 text-muted-foreground">
                <li>Shortcuts are shown directly on the toolbar buttons.</li>
                <li>Use Home to come back here and switch images.</li>
                <li>Automation is intentionally tucked away while the manual workflow is being finalized.</li>
              </ul>
            </section>
          </aside>
        </div>
      </div>
    </div>
  )
}
