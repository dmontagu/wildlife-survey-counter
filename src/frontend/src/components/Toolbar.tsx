import { FolderOpenIcon, HomeIcon, LoaderIcon, SparklesIcon } from 'lucide-react'
import type React from 'react'
import { useCallback, useRef } from 'react'
import { useAppState, useDispatch } from '../state'
import type { RecentImageRecord, ServerImageRecord } from '../types'
import ShortcutKey from './ShortcutKey'
import { Button } from './ui/button'
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
  automationEnabled: boolean
  currentFilename?: string
  detecting: boolean
  recentImages: RecentImageRecord[]
  sampleImages: ServerImageRecord[]
  onDetect: () => void
  onExportJsonOnly: () => void
  onExportResults: () => void
  onFitToWindow: () => void
  onGoHome: () => void
  onOpenImageFile: (file: File) => Promise<void>
  onOpenRecentImage: (record: RecentImageRecord) => void
  onOpenSampleImage: (record: ServerImageRecord) => void
}

export default function Toolbar({
  automationEnabled,
  currentFilename,
  detecting,
  recentImages,
  sampleImages,
  onDetect,
  onExportJsonOnly,
  onExportResults,
  onFitToWindow,
  onGoHome,
  onOpenImageFile,
  onOpenRecentImage,
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
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Wildlife Survey Counter
            </div>
          </div>

          <WorkspaceMenu
            currentFilename={currentFilename}
            recentImages={recentImages}
            sampleImages={sampleImages}
            onOpenImage={() => imageInputRef.current?.click()}
            onOpenRecentImage={onOpenRecentImage}
            onOpenSampleImage={onOpenSampleImage}
            onLoadAnnotations={() => annotationsInputRef.current?.click()}
            onExportJsonOnly={onExportJsonOnly}
            onExportResults={onExportResults}
            hasImage={hasImage}
            bboxCreationEnabled={state.bboxCreationEnabled}
            showNumbers={state.showNumbers}
            showRejected={state.showRejected}
            onFitToWindow={onFitToWindow}
            onToggleBboxCreation={() => dispatch({ type: 'TOGGLE_BBOX_CREATION' })}
            onToggleNumbers={() => dispatch({ type: 'TOGGLE_NUMBERS' })}
            onToggleRejected={() => dispatch({ type: 'TOGGLE_REJECTED' })}
          />
        </div>

        {hasImage && (
          <>
            <div className="h-7 w-px bg-border/80" />

            {automationEnabled && (
              <>
                <div className="h-7 w-px bg-border/80" />

                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="outline" size="sm" onClick={onDetect} disabled={!state.image || detecting}>
                    {detecting ? (
                      <LoaderIcon className="size-3.5 animate-spin" />
                    ) : (
                      <SparklesIcon className="size-3.5" />
                    )}
                    Automation Beta
                  </Button>
                </div>
              </>
            )}
          </>
        )}

        <div className="ml-auto flex items-center gap-2">
          {hasImage && (
            <Button variant="outline" size="sm" onClick={onGoHome}>
              <HomeIcon className="size-3.5" />
              Home
            </Button>
          )}

          <Button variant="ghost" size="sm" onClick={() => dispatch({ type: 'TOGGLE_HELP' })}>
            Help
            <ShortcutKey shortcut="?" compact />
          </Button>
        </div>
      </div>
    </div>
  )
}

function WorkspaceMenu({
  currentFilename,
  recentImages,
  sampleImages,
  onOpenImage,
  onOpenRecentImage,
  onOpenSampleImage,
  onLoadAnnotations,
  onExportJsonOnly,
  onExportResults,
  hasImage,
  bboxCreationEnabled,
  showNumbers,
  showRejected,
  onFitToWindow,
  onToggleBboxCreation,
  onToggleNumbers,
  onToggleRejected,
}: {
  currentFilename?: string
  recentImages: RecentImageRecord[]
  sampleImages: ServerImageRecord[]
  onOpenImage: () => void
  onOpenRecentImage: (record: RecentImageRecord) => void
  onOpenSampleImage: (record: ServerImageRecord) => void
  onLoadAnnotations: () => void
  onExportJsonOnly: () => void
  onExportResults: () => void
  hasImage: boolean
  bboxCreationEnabled: boolean
  showNumbers: boolean
  showRejected: boolean
  onFitToWindow: () => void
  onToggleBboxCreation: () => void
  onToggleNumbers: () => void
  onToggleRejected: () => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="max-w-[240px] gap-2">
          <FolderOpenIcon className="size-3.5" />
          <span className="truncate">{currentFilename || 'Open image'}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuItem onSelect={onOpenImage}>Open Image...</DropdownMenuItem>

        {recentImages.length > 0 && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Recent Work</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-[280px] w-80 overflow-y-auto">
              {recentImages.map((record) => (
                <DropdownMenuItem key={record.id} onSelect={() => onOpenRecentImage(record)}>
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate">{record.filename}</span>
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
              Enable bbox creation while dragging in Add mode
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={showNumbers} onCheckedChange={onToggleNumbers}>
              Show Numbers
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={showRejected} onCheckedChange={onToggleRejected}>
              Show Ignored
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
        <DropdownMenuItem onSelect={onExportJsonOnly} disabled={!hasImage}>
          Export JSON Only
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
