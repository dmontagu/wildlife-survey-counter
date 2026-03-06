import { CheckCircle2Icon, CodeIcon, EyeIcon, LoaderIcon, XCircleIcon, XIcon } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { DetectionState, DetectionStep } from '../hooks/useDetection'
import { Button } from './ui/button'

interface DetectionPanelProps {
  state: DetectionState
  onClose: () => void
}

export default function DetectionPanel({ state, onClose }: DetectionPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom as new steps arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [state.steps])

  return (
    <div className="w-80 border-l border-border flex flex-col bg-background shrink-0">
      {/* Header */}
      <div className="flex items-center justify-between px-3 h-10 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">Automation Beta</span>
          {state.status === 'running' && <LoaderIcon className="size-3.5 animate-spin text-muted-foreground" />}
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground"
        >
          <XIcon className="size-3.5" />
        </Button>
      </div>

      {/* Steps */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-2.5">
        {state.steps.map((step, i) => (
          <StepItem key={i} step={step} />
        ))}
      </div>

      {/* Footer */}
      {state.status === 'complete' && state.annotations.length > 0 && (
        <div className="px-3 py-2 border-t border-border text-xs text-muted-foreground">
          {state.annotations.length} annotation{state.annotations.length !== 1 ? 's' : ''} loaded
        </div>
      )}
    </div>
  )
}

function StepItem({ step }: { step: DetectionStep }) {
  const icon = stepIcon(step)
  const textColor = step.status === 'error' ? 'text-destructive' : 'text-foreground'

  return (
    <div className="flex items-start gap-2">
      <div className="mt-0.5 shrink-0">{icon}</div>
      <div className="min-w-0 flex-1">
        <p className={`text-xs leading-relaxed ${textColor}`}>{step.title}</p>
        {step.detail && <p className="text-xs text-muted-foreground mt-0.5">{step.detail}</p>}
      </div>
    </div>
  )
}

function stepIcon(step: DetectionStep) {
  const size = 'size-3.5'

  switch (step.type) {
    case 'text':
      return <EyeIcon className={`${size} text-blue-500`} />
    case 'tool_call':
      if (step.status === 'running') {
        return <LoaderIcon className={`${size} text-amber-500 animate-spin`} />
      }
      return <CodeIcon className={`${size} text-amber-500`} />
    case 'tool_result':
      return <CodeIcon className={`${size} text-amber-500`} />
    case 'annotations':
      return <CheckCircle2Icon className={`${size} text-green-500`} />
    case 'error':
      return <XCircleIcon className={`${size} text-destructive`} />
    default:
      return <EyeIcon className={`${size} text-muted-foreground`} />
  }
}
