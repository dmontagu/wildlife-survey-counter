import { useEffect, useState } from 'react'

const commitHash = __APP_COMMIT_HASH__
const buildTimestamp = __APP_BUILD_TIMESTAMP__

export default function BuildInfo({ className = '' }: { className?: string }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1200)
    return () => window.clearTimeout(timer)
  }, [copied])

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(commitHash)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <button
      type="button"
      onClick={() => void handleCopy()}
      className={[
        'font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground',
        className,
      ].join(' ')}
      title={`Build ${commitHash} from ${buildTimestamp}. Click to copy the commit hash.`}
      aria-label={`Build ${commitHash}`}
    >
      {copied ? 'Copied' : `Build ${commitHash}`}
    </button>
  )
}
