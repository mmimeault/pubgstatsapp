import { useEffect, useState } from 'react'
import type { ProfileResponse } from '@pubgstats/shared'
import { formatRelativeTime, shardLabel } from '@pubgstats/shared'

interface PlayerHeaderProps {
  profile: ProfileResponse
  crawling: boolean
  onRefresh: () => void
}

function initials(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9]/g, '')
  return (cleaned.slice(0, 2) || '??').toUpperCase()
}

export function PlayerHeader({ profile, crawling, onRefresh }: PlayerHeaderProps) {
  const { player, season, crawl } = profile
  const banned = player.banType && player.banType.toLowerCase() !== 'innocent'
  const availableAt = crawl.refreshAvailableAt
    ? new Date(crawl.refreshAvailableAt).getTime()
    : null
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    setNow(Date.now())
    if (!availableAt || availableAt <= Date.now()) return
    const timer = window.setInterval(() => {
      const current = Date.now()
      setNow(current)
      if (current >= availableAt) window.clearInterval(timer)
    }, 1000)
    return () => window.clearInterval(timer)
  }, [availableAt])

  const cooldownSeconds = availableAt
    ? Math.max(0, Math.ceil((availableAt - now) / 1000))
    : 0
  const refreshDisabled = crawling || cooldownSeconds > 0
  const refreshLabel = crawling
    ? 'Refreshing'
    : cooldownSeconds > 0
      ? `Refresh in ${cooldownSeconds}s`
      : 'Refresh'

  return (
    <section className="player-header panel">
      <div className="avatar" aria-hidden="true">
        {initials(player.name)}
      </div>

      <div className="player-identity">
        <div className="player-title-row">
          <h1>{player.name}</h1>
          <span className="badge badge-shard">{shardLabel(player.shard)}</span>
          {banned ? <span className="badge badge-danger">{player.banType}</span> : null}
          {player.clanId ? <span className="badge badge-muted">Clan</span> : null}
        </div>
        <div className="player-meta">
          <span>{season ? `Current ${season.label}` : 'No season data'}</span>
          <span className="dot" aria-hidden="true" />
          <span>
            Updated <strong>{formatRelativeTime(crawl.lastSyncedAt)}</strong>
          </span>
          {crawl.stale ? (
            <>
              <span className="dot" aria-hidden="true" />
              <span className="text-warn">stale</span>
            </>
          ) : null}
        </div>
      </div>

      <button
        className="button button-ghost refresh-button"
        type="button"
        onClick={onRefresh}
        disabled={refreshDisabled}
        title={
          crawling
            ? 'Crawl already in progress'
            : cooldownSeconds > 0
              ? `Refresh available in ${cooldownSeconds}s`
              : 'Re-crawl this player'
        }
      >
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          className={crawling ? 'spin' : undefined}
        >
          <path
            d="M12 5a7 7 0 0 1 6.7 5h-2.1A5 5 0 0 0 7.1 9.3L9 11H4V6l1.8 1.8A9 9 0 0 1 12 3V5Zm6 13.2A9 9 0 0 1 4.3 14h2.1A7 7 0 0 0 16.9 14.7L15 13h5v5l-1.8-1.8Z"
            fill="currentColor"
          />
        </svg>
        {refreshLabel}
      </button>
    </section>
  )
}
