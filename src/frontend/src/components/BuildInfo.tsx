const commitHash = __APP_COMMIT_HASH__
const buildTimestamp = __APP_BUILD_TIMESTAMP__

export default function BuildInfo({ className = '' }: { className?: string }) {
  return (
    <span
      className={[
        'shrink-0 whitespace-nowrap font-mono text-[11px] tabular-nums text-muted-foreground',
        className,
      ].join(' ')}
      title={`Build ${commitHash} from ${buildTimestamp}`}
    >
      Build {commitHash}
    </span>
  )
}
