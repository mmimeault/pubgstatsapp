import type { CrawlInfo, JobSummary } from '@pubgstats/shared'

const PHASE_LABELS: Record<string, string> = {
  queued: 'Waiting for the crawler',
  resolving_player: 'Looking up player',
  seasons: 'Syncing season list',
  season_stats: 'Fetching season stats',
  matches: 'Fetching matches',
  telemetry: 'Indexing kill events',
  done: 'Finishing up',
  failed: 'Failed',
}

function activeJob(job: JobSummary | null): job is JobSummary {
  return job !== null && (job.status === 'pending' || job.status === 'running')
}

export function CrawlBanner({ crawl, job }: { crawl: CrawlInfo; job: JobSummary | null }) {
  const runningJob = activeJob(job) ? job : activeJob(crawl.job) ? crawl.job : null

  if (runningJob) {
    return (
      <div className="crawl-banner crawl-running">
        <div className="crawl-copy">
          <strong>{PHASE_LABELS[runningJob.phase] ?? runningJob.phase}</strong>
          <span>
            {runningJob.message ??
              'PUBG lookups are rate-limited to 10 requests/minute. Only new matches are fetched.'}
          </span>
        </div>
        <div className="crawl-progress" aria-label={`Crawl progress ${runningJob.progress}%`}>
          <div className="crawl-progress-fill" style={{ width: `${Math.max(4, runningJob.progress)}%` }} />
        </div>
        <span className="crawl-pct">{runningJob.progress}%</span>
      </div>
    )
  }

  if (crawl.state === 'failed') {
    return (
      <div className="crawl-banner crawl-error">
        <strong>Crawl failed.</strong>
        <span>{crawl.job?.error ?? 'The crawler could not refresh this player.'}</span>
      </div>
    )
  }

  if (crawl.state === 'offline') {
    return (
      <div className="crawl-banner crawl-warning">
        <strong>Crawler offline.</strong>
        <span>
          Showing cached data. Run <code>make dev</code> (or start the crawler daemon) to enable refresh.
        </span>
      </div>
    )
  }

  if (crawl.stale) {
    return (
      <div className="crawl-banner crawl-stale">
        <strong>Data is getting old.</strong>
        <span>Hit refresh to ask the crawler for the latest games.</span>
      </div>
    )
  }

  return null
}

export function CrawlProgressCard({ name, job }: { name: string; job: JobSummary | null }) {
  const progress = job?.progress ?? 0
  const phase = job ? (PHASE_LABELS[job.phase] ?? job.phase) : 'Starting the crawler'

  return (
    <section className="panel crawl-card" aria-live="polite">
      <div className="crawl-orbit" aria-hidden="true">
        <span className="orbit-ring" />
        <span className="orbit-dot" />
      </div>
      <h2>Crawling {name}</h2>
      <p className="crawl-card-sub">
        {phase}
        {job?.message ? ` · ${job.message}` : ''}
      </p>
      <div className="crawl-progress large">
        <div className="crawl-progress-fill" style={{ width: `${Math.max(4, progress)}%` }} />
      </div>
      <span className="crawl-card-pct">{progress}%</span>
      <p className="crawl-card-note">
        First lookup fetches the player, current season and up to 20 matches. Matches are cached forever,
        so later refreshes only fetch new games.
      </p>
    </section>
  )
}
