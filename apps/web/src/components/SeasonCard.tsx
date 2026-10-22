import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type {
  JobSummary,
  ModeStats,
  ProfileResponse,
  SeasonOption,
  SeasonScanInfo,
  SeasonStatsResponse,
} from '@pubgstats/shared'
import {
  formatDuration,
  formatNumber,
  formatPercent,
  modeLabel,
  seasonLabel,
} from '@pubgstats/shared'
import { getSeasonStats, getSeasons } from '../api'

interface SeasonCardProps {
  profile: ProfileResponse
  shard: string
}

interface SeasonView {
  season: { id: string; label: string; isCurrent: boolean }
  modes: ModeStats[]
  totals: ModeStats
  defaultMode: string
  hasGames: boolean
}

interface StatCardProps {
  label: string
  value: string
  detail: string
  tone?: 'accent' | 'green' | 'blue'
}

function StatCard({ label, value, detail, tone }: StatCardProps) {
  return (
    <div className={`stat-card ${tone ? `stat-${tone}` : ''}`}>
      <span className="stat-label">{label}</span>
      <strong className="stat-value">{value}</strong>
      <span className="stat-detail">{detail}</span>
    </div>
  )
}

function secondaryStats(mode: ModeStats) {
  return [
    { label: 'Wins', value: formatNumber(mode.wins) },
    { label: 'Kills', value: formatNumber(mode.kills) },
    { label: 'Assists', value: formatNumber(mode.assists) },
    { label: 'Avg. survival', value: formatDuration(mode.avgSurvival) },
    { label: 'Longest kill', value: `${formatNumber(mode.longestKill, 1)} m` },
    ...(mode.bestRankPoint !== null
      ? [{ label: 'Best RP', value: formatNumber(mode.bestRankPoint) }]
      : []),
  ]
}

export function SeasonCard({ profile, shard }: SeasonCardProps) {
  const [searchParams, setSearchParams] = useSearchParams()
  const currentSeasonId = profile.season?.id ?? null
  const [options, setOptions] = useState<SeasonOption[]>([])
  const [scan, setScan] = useState<SeasonScanInfo | null>(null)
  const [selectedId, setSelectedId] = useState(
    () => searchParams.get('season') ?? currentSeasonId ?? '',
  )
  const [seasonData, setSeasonData] = useState<SeasonStatsResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [job, setJob] = useState<JobSummary | null>(null)
  const [activeMode, setActiveMode] = useState(profile.defaultMode)

  const currentView: SeasonView | null = profile.season
    ? {
        season: profile.season,
        modes: profile.modes,
        totals: profile.totals,
        defaultMode: profile.defaultMode,
        hasGames: profile.modes.length > 0,
      }
    : null

  const isCurrent = selectedId === currentSeasonId
  const view = isCurrent
    ? currentView
    : seasonData?.season.id === selectedId
      ? seasonData
      : null

  const fallbackOptions: SeasonOption[] = profile.season
    ? [
        {
          ...profile.season,
          fetched: true,
          rounds: profile.totals.rounds,
        },
      ]
    : []
  const baseOptions = options.length > 0
    ? options.filter((option) => option.isCurrent || option.rounds > 0)
    : fallbackOptions
  const effectiveOptions =
    selectedId && !baseOptions.some((option) => option.id === selectedId)
      ? [
          ...baseOptions,
          {
            id: selectedId,
            label: seasonLabel(selectedId),
            isCurrent: false,
            fetched: false,
            rounds: 0,
          },
        ]
      : baseOptions

  const selectedOption = effectiveOptions.find((option) => option.id === selectedId)
  const selectedLabel =
    view?.season.label ?? selectedOption?.label ?? seasonLabel(selectedId)

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined

    const load = async () => {
      const result = await getSeasons(shard, profile.player.name)
      if (cancelled) return
      if (result) {
        setOptions(result.seasons)
        setScan(result.scan)
        if (result.scan.status !== 'done') {
          timer = window.setTimeout(() => void load(), 3000)
        }
      }
    }

    void load()
    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
    }
  }, [shard, profile.player.name, profile.player.lastSyncedAt])

  useEffect(() => {
    const fromUrl = searchParams.get('season')
    if (fromUrl && fromUrl !== selectedId) {
      setSelectedId(fromUrl)
    } else if (!fromUrl && currentSeasonId && selectedId !== currentSeasonId) {
      setSelectedId(currentSeasonId)
    }
  }, [searchParams, selectedId, currentSeasonId])

  useEffect(() => {
    if (!selectedId && currentSeasonId) setSelectedId(currentSeasonId)
  }, [selectedId, currentSeasonId])

  useEffect(() => {
    if (!selectedId || selectedId === currentSeasonId) {
      setSeasonData(null)
      setLoading(false)
      setError(null)
      setJob(null)
      return
    }

    let cancelled = false
    let timer: number | undefined
    setSeasonData(null)
    setLoading(true)
    setError(null)
    setJob(null)

    const load = async () => {
      const result = await getSeasonStats(shard, profile.player.name, selectedId)
      if (cancelled) return

      if (result.kind === 'season') {
        setSeasonData(result.data)
        setLoading(false)
        setError(null)
        setJob(null)
        setOptions((previous) =>
          previous.map((option) =>
            option.id === selectedId
              ? {
                  ...option,
                  fetched: true,
                  rounds: result.data.totals.rounds,
                }
              : option,
          ),
        )
      } else if (result.kind === 'crawling') {
        setJob(result.job)
        setLoading(true)
        setError(null)
        timer = window.setTimeout(() => void load(), 1200)
      } else {
        setError(result.message)
        setLoading(false)
        setJob(null)
      }
    }

    void load()
    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
    }
  }, [selectedId, currentSeasonId, shard, profile.player.name])

  useEffect(() => {
    setActiveMode(view?.defaultMode ?? 'all')
  }, [selectedId, view?.defaultMode])

  const modes = view?.modes ?? []
  const mode = activeMode === 'all' ? view?.totals : modes.find((item) => item.mode === activeMode)

  function selectSeason(seasonId: string) {
    setSelectedId(seasonId)
    const next = new URLSearchParams(searchParams)
    next.set('season', seasonId)
    setSearchParams(next, { replace: true })
  }

  return (
    <section className="panel season-card">
      <div className="section-heading">
        <div>
          <h2>
            {view?.season.isCurrent ? 'Current season' : 'Season stats'}{' '}
            <span className="badge badge-muted">All games</span>
          </h2>
          <p className="section-subtitle">
            {selectedLabel}
            {view && mode
              ? ` · ${activeMode === 'all' ? 'All modes' : modeLabel(mode.mode)} · ${formatNumber(mode.rounds)} season games`
              : loading
                ? ' · loading…'
                : ''}
          </p>
        </div>

        <div className="season-controls">
          <label className="season-picker">
            <span>Season</span>
            <select
              value={selectedId}
              onChange={(event) => selectSeason(event.target.value)}
              aria-label="Select season"
            >
              {effectiveOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                  {option.isCurrent
                    ? ' (current)'
                    : option.fetched
                      ? ` · ${formatNumber(option.rounds)} games`
                      : ' · not loaded'}
                </option>
              ))}
            </select>
          </label>

          {modes.length > 0 ? (
            <div className="mode-tabs" role="tablist" aria-label="Game mode">
              <button
                type="button"
                role="tab"
                aria-selected={activeMode === 'all'}
                className={activeMode === 'all' ? 'mode-tab active' : 'mode-tab'}
                onClick={() => setActiveMode('all')}
              >
                All modes
              </button>
              {modes.map((item) => (
                <button
                  key={item.mode}
                  type="button"
                  role="tab"
                  aria-selected={activeMode === item.mode}
                  className={activeMode === item.mode ? 'mode-tab active' : 'mode-tab'}
                  onClick={() => setActiveMode(item.mode)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {scan && scan.status !== 'done' ? (
        <div className="season-scan" aria-live="polite">
          <span className="season-scan-copy">
            <span>Scanning season history</span>
            <strong>
              {scan.scanned}/{scan.total}
            </strong>
            <span>{scan.played} played</span>
          </span>
          <div className="crawl-progress season-scan-bar">
            <div
              className="crawl-progress-fill"
              style={{
                width: `${Math.max(4, (scan.scanned / Math.max(1, scan.total)) * 100)}%`,
              }}
            />
          </div>
          {scan.nextBatchAt ? <span className="season-scan-wait">next batch queued</span> : null}
        </div>
      ) : null}

      {loading ? (
        <div className="season-loading" aria-live="polite">
          <span className="season-spinner" aria-hidden="true" />
          <div className="season-loading-copy">
            <strong>Fetching {selectedLabel}…</strong>
            <span>
              {job?.message ?? 'One PUBG API request; cached after this.'}
            </span>
          </div>
          {job ? (
            <div className="crawl-progress season-loading-progress">
              <div
                className="crawl-progress-fill"
                style={{ width: `${Math.max(4, job.progress)}%` }}
              />
            </div>
          ) : null}
        </div>
      ) : error ? (
        <div className="season-error" role="alert">
          <strong>Could not load {selectedLabel}.</strong>
          <span>{error}</span>
        </div>
      ) : !view || !view.hasGames || !mode ? (
        <div className="empty-state">
          <strong>No games recorded in {selectedLabel}.</strong>
          <p>PUBG returned no season stats for this player in that season.</p>
        </div>
      ) : (
        <>
          <div className="stat-grid">
            <StatCard
              label="K/D"
              value={formatNumber(mode.kd, 2)}
              detail={`${formatNumber(mode.kills)} kills / ${formatNumber(Math.max(0, mode.rounds - mode.wins))} deaths`}
              tone="accent"
            />
            <StatCard
              label="Avg. damage"
              value={formatNumber(mode.avgDamage, 1)}
              detail={`${formatNumber(mode.damage)} total`}
              tone="blue"
            />
            <StatCard
              label="Win rate"
              value={formatPercent(mode.winRate)}
              detail={`${formatNumber(mode.wins)} wins in ${formatNumber(mode.rounds)} rounds`}
              tone="green"
            />
            <StatCard
              label="Top 10"
              value={formatPercent(mode.top10Rate)}
              detail={`${formatNumber(mode.top10s)} top-10 finishes`}
            />
            <StatCard
              label="Headshots"
              value={formatPercent(mode.hsRate)}
              detail={`${formatNumber(mode.headshots)} headshot kills`}
            />
            <StatCard
              label="Rounds"
              value={formatNumber(mode.rounds)}
              detail={`${formatDuration(mode.timeSurvived)} survived`}
            />
          </div>

          <div className="secondary-stats">
            {secondaryStats(mode).map((stat) => (
              <div key={stat.label} className="secondary-stat">
                <span>{stat.label}</span>
                <strong>{stat.value}</strong>
              </div>
            ))}
          </div>
        </>
      )}

      {view ? (
        <p className="season-note">
          This card aggregates all {formatNumber(mode?.rounds ?? view.totals.rounds)} games in{' '}
          {view.season.label} from PUBG's season endpoint — not the loaded match details below.
          PUBG doesn't expose a bot split for season totals, and match history only goes back 14
          days (max 32 match IDs), so no-bot K/D is shown only for the loaded matches.
        </p>
      ) : null}
    </section>
  )
}
