import { Link, Route, Routes, useParams } from 'react-router-dom'
import { useEffect, useState } from 'react'
import type { MatchSummary, ProfileResponse, Shard } from '@pubgstats/shared'
import { SHARDS, formatRelativeTime, shardLabel } from '@pubgstats/shared'
import { SearchBar } from './components/SearchBar'
import { PlayerHeader } from './components/PlayerHeader'
import { SeasonCard } from './components/SeasonCard'
import { MatchesTable } from './components/MatchesTable'
import { MatchDetailPage } from './components/MatchDetailPage'
import { CrawlBanner, CrawlProgressCard } from './components/CrawlBanner'
import { usePlayerProfile } from './usePlayerProfile'
import { getMatchesPage } from './api'

const SITE_LABEL =
  import.meta.env.VITE_SITE_LABEL ?? (import.meta.env.PROD ? 'live' : 'local')

function Brand() {
  return (
    <Link className="brand" to="/">
      <span className="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <path
            d="M12 2c3.4 0 6 2.4 6 5.6 0 2.2-1.2 3.8-2.6 5.1l-1.6 1.5V20h-3.6v-5.8L8.6 12.7C7.2 11.4 6 9.8 6 7.6 6 4.4 8.6 2 12 2Zm0 2.8c-1.7 0-3 1.2-3 2.8 0 1.1.7 2.2 1.9 3.2L12 11.8l1.1-1c1.2-1 1.9-2.1 1.9-3.2 0-1.6-1.3-2.8-3-2.8Z"
            fill="currentColor"
          />
        </svg>
      </span>
      <span className="brand-text">
        PUBG<span>STATS</span>
      </span>
    </Link>
  )
}

function PageFooter() {
  return (
    <footer className="app-footer">
      <div className="container footer-inner">
        <span>
          Crawler-backed cache · SQLite · local-first. Data from the official PUBG API.
        </span>
        <span>Not affiliated with KRAFTON. PUBG is a registered trademark of KRAFTON, Inc.</span>
      </div>
    </footer>
  )
}

function LandingPage() {
  useEffect(() => {
    document.title = 'PUBGSTATS — local PUBG stats lookup'
  }, [])

  return (
    <main className="container">
      <section className="hero">
        <span className="eyebrow">
          <span className="live-dot" /> Local crawler · cached matches · zero repeat fetches
        </span>
        <h1 className="hero-title">
          Read the lobby.
          <br />
          <span className="accent">Know your drop.</span>
        </h1>
        <p className="hero-sub">
          Type an exact PUBG name to load the current season, the last 20 matches, and every kill
          tagged as player or bot. The first lookup warms a local cache; refreshes only crawl what
          changed.
        </p>

        <div className="hero-search">
          <SearchBar />
          <div className="hero-chips">
            <span>Try the demo:</span>
            <Link to="/player/steam/DarkNext3000" className="chip">
              DarkNext3000
            </Link>
            <span className="hero-note">names are case-sensitive</span>
          </div>
        </div>
      </section>

      <section className="feature-grid">
        <article className="panel feature">
          <span className="feature-number">01</span>
          <h3>One crawl, durable cache</h3>
          <p>
            A standalone crawler talks to the PUBG API and writes to SQLite. The API only reads, so a
            page view never burns a request.
          </p>
        </article>
        <article className="panel feature">
          <span className="feature-number">02</span>
          <h3>Only new matches</h3>
          <p>
            Recent match IDs are diffed against the database. Stored matches are immutable, so each one
            is fetched exactly once.
          </p>
        </article>
        <article className="panel feature">
          <span className="feature-number">03</span>
          <h3>Built for 10 req/min</h3>
          <p>
            A persistent rolling-window limiter spans restarts, honors 429 resets and serializes
            rate-limited calls.
          </p>
        </article>
        <article className="panel feature">
          <span className="feature-number">04</span>
          <h3>Bot-aware kill feed</h3>
          <p>
            Match telemetry is parsed into per-game kill events with victim, weapon, distance and a
            player/bot tag. Telemetry doesn't consume API requests.
          </p>
        </article>
      </section>

      <section className="pipeline panel">
        <div className="pipeline-step">
          <span className="pipeline-dot api" />
          <div>
            <strong>PUBG API</strong>
            <span>3 rate-limited calls per cold crawl</span>
          </div>
        </div>
        <span className="pipeline-arrow" aria-hidden="true">
          →
        </span>
        <div className="pipeline-step">
          <span className="pipeline-dot crawler" />
          <div>
            <strong>Crawler daemon</strong>
            <span>queue · limiter · incremental upsert</span>
          </div>
        </div>
        <span className="pipeline-arrow" aria-hidden="true">
          →
        </span>
        <div className="pipeline-step">
          <span className="pipeline-dot db" />
          <div>
            <strong>SQLite</strong>
            <span>WAL · jobs · matches · stats</span>
          </div>
        </div>
        <span className="pipeline-arrow" aria-hidden="true">
          →
        </span>
        <div className="pipeline-step">
          <span className="pipeline-dot web" />
          <div>
            <strong>Read API + web</strong>
            <span>profile · season · 20 matches</span>
          </div>
        </div>
      </section>
    </main>
  )
}

function ErrorCard({
  title,
  message,
  hint,
}: {
  title: string
  message: string
  hint?: string
}) {
  return (
    <section className="panel error-card" role="alert">
      <span className="error-icon" aria-hidden="true">
        !
      </span>
      <div>
        <h2>{title}</h2>
        <p>{message}</p>
        {hint ? <p className="error-hint">{hint}</p> : null}
      </div>
    </section>
  )
}

function mergeMatches(previous: MatchSummary[], page: MatchSummary[]): MatchSummary[] {
  const seen = new Set(page.map((match) => match.id))
  return [...page, ...previous.filter((match) => !seen.has(match.id))]
}

function ProfilePage() {
  const params = useParams<{ shard: string; name: string }>()
  const shard = (params.shard && SHARDS.includes(params.shard as Shard) ? params.shard : 'steam') as Shard
  const name = params.name ?? ''
  const { profile, job, error, loading, crawling, refresh } = usePlayerProfile(shard, name)
  const [loadedMatches, setLoadedMatches] = useState<MatchSummary[]>([])
  const [totalMatches, setTotalMatches] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null)

  useEffect(() => {
    window.scrollTo({ top: 0 })
  }, [shard, name])

  useEffect(() => {
    if (!profile) {
      setLoadedMatches([])
      setTotalMatches(0)
      setLoadMoreError(null)
      return
    }
    // Merge the profile's first page into already-loaded pages. During a
    // refresh the API can briefly return a partial first page; merging keeps
    // the previous rows and adds new ones instead of shrinking the list.
    setLoadedMatches((previous) => mergeMatches(previous, profile.recentMatches))
    setTotalMatches(profile.recentMatchesTotal)
  }, [profile])

  async function loadMore() {
    if (!profile) return
    const current = loadedMatches.length || profile.recentMatches.length
    const total = totalMatches || profile.recentMatchesTotal
    if (loadingMore || current >= total) return
    setLoadingMore(true)
    setLoadMoreError(null)
    const result = await getMatchesPage(
      profile.player.shard,
      profile.player.name,
      profile.meta.recentMatchesLimit,
      current,
    )
    if (result.kind === 'matches') {
      setLoadedMatches((previous) => {
        const base = previous.length > 0 ? previous : profile.recentMatches
        const seen = new Set(base.map((match) => match.id))
        return [...base, ...result.page.matches.filter((match) => !seen.has(match.id))]
      })
      setTotalMatches(result.page.pagination.total)
    } else {
      setLoadMoreError(result.message)
    }
    setLoadingMore(false)
  }

  const visibleMatches = loadedMatches.length > 0 ? loadedMatches : (profile?.recentMatches ?? [])
  const visibleTotal = totalMatches || profile?.recentMatchesTotal || 0

  useEffect(() => {
    document.title = profile?.player.name ? `${profile.player.name} · PUBGSTATS` : 'PUBGSTATS'
  }, [profile?.player.name])

  return (
    <main className="container profile-page">
      <div className="profile-toolbar">
        <div className="toolbar-context">
          <span className="context-label">Player lookup</span>
          <span className="context-value">
            {shardLabel(shard)} · {name}
          </span>
        </div>
        <SearchBar
          key={`${shard}:${name}`}
          compact
          defaultShard={shard}
          defaultName={name}
        />
      </div>

      {error && !profile ? (
        <ErrorCard title={error.title} message={error.message} hint={error.hint} />
      ) : null}

      {!profile && !error && (loading || crawling) ? (
        <CrawlProgressCard name={name} job={job} />
      ) : null}

      {profile ? (
        <>
          <PlayerHeader profile={profile} crawling={crawling} onRefresh={() => void refresh()} />
          {error ? (
            <div className="inline-error" role="alert">
              <strong>{error.title}</strong>
              <span>{error.message}</span>
              {error.hint ? <span className="muted">{error.hint}</span> : null}
            </div>
          ) : null}
          <CrawlBanner crawl={profile.crawl} job={job} />
          <SeasonCard profile={profile} shard={profile.player.shard} />
          <MatchesTable
            matches={visibleMatches}
            total={visibleTotal}
            pageSize={profile.meta.recentMatchesLimit}
            loadingMore={loadingMore}
            loadMoreError={loadMoreError}
            onLoadMore={() => void loadMore()}
            shard={profile.player.shard}
            playerName={profile.player.name}
          />
          <p className="freshness">
            Crawled {formatRelativeTime(profile.crawl.lastSyncedAt)} · cache is served instantly when
            fresh · refresh to re-crawl.
          </p>
        </>
      ) : null}
    </main>
  )
}

function ProfileRoute() {
  const params = useParams<{ shard: string; name: string }>()
  return <ProfilePage key={`${params.shard ?? ''}:${params.name ?? ''}`} />
}

export default function App() {
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="container header-inner">
          <Brand />
          <div className="header-meta">
            <span className="live-dot" />
            <span>{SITE_LABEL}</span>
            <span className="header-sep" aria-hidden="true" />
            <span className="header-mono">SQLite</span>
          </div>
        </div>
      </header>

      <div className="content">
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/player/:shard/:name" element={<ProfileRoute />} />
          <Route
            path="/player/:shard/:name/match/:matchId"
            element={<MatchDetailPage />}
          />
          <Route
            path="*"
            element={
              <main className="container">
                <ErrorCard title="Page not found" message="That route does not exist." hint="Head back home to search a player." />
              </main>
            }
          />
        </Routes>
      </div>

      <PageFooter />
    </div>
  )
}
