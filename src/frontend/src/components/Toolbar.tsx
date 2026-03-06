import { ChevronDownIcon, FolderOpenIcon, HomeIcon, PencilLineIcon } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { displayNameFor } from '../lib/image-names'
import { useAppState, useDispatch } from '../state'
import type { RecentImageRecord, ServerImageRecord } from '../types'
import ShortcutKey from './ShortcutKey'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'

interface ToolbarProps {
  currentDisplayName?: string
  currentFilename?: string
  recentImages: RecentImageRecord[]
  sampleImages: ServerImageRecord[]
  onExportAnnotatedImage: () => void
  onExportJsonOnly: () => void
  onExportOriginalImage: () => void
  onExportResults: () => void
  onFitToWindow: () => void
  onGoHome: () => void
  onOpenImageFile: (file: File) => Promise<void>
  onOpenRecentImage: (record: RecentImageRecord) => void
  onRenameImage: (name: string | null) => void
  onOpenSampleImage: (record: ServerImageRecord) => void
}

export default function Toolbar({
  currentDisplayName,
  currentFilename,
  recentImages,
  sampleImages,
  onExportAnnotatedImage,
  onExportJsonOnly,
  onExportOriginalImage,
  onExportResults,
  onFitToWindow,
  onGoHome,
  onOpenImageFile,
  onOpenRecentImage,
  onRenameImage,
  onOpenSampleImage,
}: ToolbarProps) {
  const state = useAppState()
  const dispatch = useDispatch()
  const hasImage = !!state.image
  const imageInputRef = useRef<HTMLInputElement>(null)
  const annotationsInputRef = useRef<HTMLInputElement>(null)

  const handleImageUpload = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0]
      if (!file) return
      await onOpenImageFile(file)
      event.target.value = ''
    },
    [onOpenImageFile],
  )

  const handleAnnotationUpload = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0]
      if (!file) return

      const reader = new FileReader()
      reader.onload = () => {
        try {
          const parsed = JSON.parse(String(reader.result))
          dispatch({
            type: 'LOAD_ANNOTATIONS',
            annotations: parsed.annotations || parsed,
          })
        } catch {
          console.error('Could not import annotations JSON.')
        }
      }
      reader.readAsText(file)
      event.target.value = ''
    },
    [dispatch],
  )

  return (
    <div className="border-b border-border bg-card/70 px-3 py-2 backdrop-blur-sm">
      <input ref={imageInputRef} type="file" accept="image/*" onChange={handleImageUpload} className="hidden" />
      <input
        ref={annotationsInputRef}
        type="file"
        accept=".json,application/json"
        onChange={handleAnnotationUpload}
        className="hidden"
      />

      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-2">
        <div className="mr-1 flex items-center gap-2">
          <div className="hidden min-w-0 sm:flex items-center">
            <button
              type="button"
              onClick={hasImage ? onGoHome : undefined}
              className={[
                'text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground',
                hasImage ? 'cursor-pointer transition-colors hover:text-foreground' : 'cursor-default',
              ].join(' ')}
              aria-label={hasImage ? 'Go to home page' : undefined}
            >
              Wildlife Survey Counter
            </button>
          </div>

          {hasImage ? (
            <WorkspaceMenu
              currentDisplayName={currentDisplayName}
              currentFilename={currentFilename}
              recentImages={recentImages}
              sampleImages={sampleImages}
              onOpenImage={() => imageInputRef.current?.click()}
              onOpenRecentImage={onOpenRecentImage}
              onOpenSampleImage={onOpenSampleImage}
              onLoadAnnotations={() => annotationsInputRef.current?.click()}
              onExportAnnotatedImage={onExportAnnotatedImage}
              onExportJsonOnly={onExportJsonOnly}
              onExportOriginalImage={onExportOriginalImage}
              onExportResults={onExportResults}
              hasImage={hasImage}
              bboxCreationEnabled={state.bboxCreationEnabled}
              showNumbers={state.showNumbers}
              showRejected={state.showRejected}
              onFitToWindow={onFitToWindow}
              onRenameImage={onRenameImage}
              onToggleBboxCreation={() => dispatch({ type: 'TOGGLE_BBOX_CREATION' })}
              onToggleNumbers={() => dispatch({ type: 'TOGGLE_NUMBERS' })}
              onToggleRejected={() => dispatch({ type: 'TOGGLE_REJECTED' })}
            />
          ) : (
            <Button variant="outline" size="sm" onClick={() => imageInputRef.current?.click()}>
              <FolderOpenIcon className="size-3.5" />
              Open image
            </Button>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {hasImage && (
            <Button variant="outline" size="sm" onClick={onGoHome}>
              <HomeIcon className="size-3.5" />
              Home
            </Button>
          )}

          {hasImage ? (
            <Button variant="ghost" size="sm" onClick={() => dispatch({ type: 'TOGGLE_HELP' })}>
              Help
              <ShortcutKey shortcut="?" compact />
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function WorkspaceMenu({
  currentDisplayName,
  currentFilename,
  recentImages,
  sampleImages,
  onOpenImage,
  onOpenRecentImage,
  onOpenSampleImage,
  onLoadAnnotations,
  onExportAnnotatedImage,
  onExportJsonOnly,
  onExportOriginalImage,
  onExportResults,
  hasImage,
  bboxCreationEnabled,
  showNumbers,
  showRejected,
  onFitToWindow,
  onRenameImage,
  onToggleBboxCreation,
  onToggleNumbers,
  onToggleRejected,
}: {
  currentDisplayName?: string
  currentFilename?: string
  recentImages: RecentImageRecord[]
  sampleImages: ServerImageRecord[]
  onOpenImage: () => void
  onOpenRecentImage: (record: RecentImageRecord) => void
  onOpenSampleImage: (record: ServerImageRecord) => void
  onLoadAnnotations: () => void
  onExportAnnotatedImage: () => void
  onExportJsonOnly: () => void
  onExportOriginalImage: () => void
  onExportResults: () => void
  hasImage: boolean
  bboxCreationEnabled: boolean
  showNumbers: boolean
  showRejected: boolean
  onFitToWindow: () => void
  onRenameImage: (name: string | null) => void
  onToggleBboxCreation: () => void
  onToggleNumbers: () => void
  onToggleRejected: () => void
}) {
  const [renameOpen, setRenameOpen] = useState(false)
  const [draftName, setDraftName] = useState(currentDisplayName ?? currentFilename ?? '')

  useEffect(() => {
    if (!renameOpen) {
      setDraftName(currentDisplayName ?? currentFilename ?? '')
    }
  }, [currentDisplayName, currentFilename, renameOpen])

  const openRenameDialog = useCallback(() => {
    setDraftName(currentDisplayName ?? currentFilename ?? '')
    setRenameOpen(true)
  }, [currentDisplayName, currentFilename])

  const handleRenameSubmit = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      onRenameImage(draftName || null)
      setRenameOpen(false)
    },
    [draftName, onRenameImage],
  )

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="max-w-[240px] gap-2">
            <FolderOpenIcon className="size-3.5" />
            <span className="truncate">{currentDisplayName || currentFilename || 'Open image'}</span>
            <ChevronDownIcon className="size-3.5 opacity-70" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          <DropdownMenuItem onSelect={onOpenImage}>Open Image...</DropdownMenuItem>

          {hasImage && (
            <DropdownMenuItem onSelect={openRenameDialog}>
              Rename Image...
              <DropdownMenuShortcut>
                <PencilLineIcon className="size-3.5" />
              </DropdownMenuShortcut>
            </DropdownMenuItem>
          )}

          {recentImages.length > 0 && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Recent Work</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-[280px] w-80 overflow-y-auto">
                {recentImages.map((record) => (
                  <DropdownMenuItem key={record.id} onSelect={() => onOpenRecentImage(record)}>
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate">{displayNameFor(record)}</span>
                      <span className="text-xs text-muted-foreground">
                        {record.counted} counted, {record.bulls} bulls, {record.spikes} spikes
                      </span>
                    </div>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}

          {sampleImages.length > 0 && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Dev Samples</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-[280px] overflow-y-auto">
                {sampleImages.map((record) => (
                  <DropdownMenuItem key={record.url} onSelect={() => onOpenSampleImage(record)}>
                    {record.filename}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}

          <DropdownMenuItem onSelect={onLoadAnnotations}>Load Annotation JSON...</DropdownMenuItem>

          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Advanced</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-72">
              <DropdownMenuCheckboxItem checked={bboxCreationEnabled} onCheckedChange={onToggleBboxCreation}>
                Enable advanced bbox tool (Alt + drag)
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem checked={showNumbers} onCheckedChange={onToggleNumbers}>
                Show Numbers
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem checked={showRejected} onCheckedChange={onToggleRejected}>
                Show Excluded Markers
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={onFitToWindow}>Fit to Window</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onExportResults} disabled={!hasImage}>
            Export Results
            <DropdownMenuShortcut>JSON + JPG</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onExportAnnotatedImage} disabled={!hasImage}>
            Export Annotated Image
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onExportOriginalImage} disabled={!hasImage}>
            Export Original Image
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onExportJsonOnly} disabled={!hasImage}>
            Export JSON Only
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rename image</DialogTitle>
            <DialogDescription>
              Choose a clearer name for browsing recent work and naming exports. Leave it blank to use the original
              filename.
            </DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={handleRenameSubmit}>
            <label className="flex flex-col gap-2 text-sm">
              <span className="font-medium text-foreground">Display name</span>
              <input
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                placeholder={currentFilename || 'Survey image'}
                className="h-10 rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none transition-colors focus:border-primary"
              />
            </label>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setDraftName(currentFilename ?? '')}>
                Reset
              </Button>
              <Button type="submit">Save Name</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
