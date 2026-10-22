import type { MatchSummary } from '@pubgstats/shared'
import {
  computeRecentSummary,
  formatDateTime,
  formatDistance,
  formatDuration,
  formatNumber,
} from '@pubgstats/shared'
import { useNavigate } from 'react-router-dom'
import { mapClass } from '../mapClass'

interface MatchesTableProps {
  matches: MatchSummary[]
  total: number
  pageSize: number
  loadingMore: boolean
  loadMoreError?: string | null
  onLoadMore: () => void
  shard: string
  playerName: string
}

function placementClass(placement: number): string {
  if (placement === 1) return 'placement placement-win'
  if (placement > 0 && placement <= 10) return 'placement placement-top'
  return 'placement'
}

export function MatchesTable({
  matches,
  total,
  pageSize,
  loadingMore,
  loadMoreError,
  onLoadMore,
  shard,
  playerName,
}: MatchesTableProps) {
  const navigate = useNavigate()
  const summary = computeRecentSummary(matches)
  const killDataMatches = matches.filter((match) => match.killDataFetched).length

  if (matches.length === 0) {
    return (
      <section className="panel matches-card">
        <div className="section-heading">
          <div>
            <h2>Recent matches</h2>
            <p className="section-subtitle">The crawler stores each match once, then reuses it forever.</p>
          </div>
        </div>
        <div className="empty-state">
          <strong>No matches cached yet.</strong>
          <p>Refresh this player to crawl their most recent matches.</p>
        </div>
      </section>
    )
  }

  return (
    <section className="panel matches-card">
      <div className="section-heading matches-heading">
        <div>
          <h2>Recent matches</h2>
          <p className="section-subtitle">
            Last {matches.length} loaded match details · no-bot K/D covers these games only · click
            a row for the full breakdown
            {killDataMatches < matches.length
              ? ` · kill data ${killDataMatches}/${matches.length}`
              : ''}
          </p>
        </div>
        <div className="recent-summary">
          <div>
            <span>Avg. place</span>
            <strong>#{formatNumber(summary.avgPlacement, 1)}</strong>
          </div>
          <div className="kd-summary-item">
            <span>K/D · last {matches.length}</span>
            <strong>
              {formatNumber(summary.kd, 2)}
              <em
                className="kd-alt"
                title="K/D excluding bot kills, based only on the loaded match details above. PUBG only exposes recent match IDs (max 32 within 14 days), so a full-season no-bot K/D is not available."
              >
                {' '}
                ({formatNumber(summary.kdNoBots, 2)} w/o bots)
                {killDataMatches < matches.length ? '*' : ''}
              </em>
            </strong>
          </div>
          <div>
            <span>Avg. damage</span>
            <strong>{formatNumber(summary.avgDamage, 0)}</strong>
          </div>
          <div>
            <span>Wins</span>
            <strong>{formatNumber(summary.wins)}</strong>
          </div>
          <div>
            <span>Bot kills</span>
            <strong>{formatNumber(summary.botKills)}</strong>
          </div>
          <div>
            <span>Player kills</span>
            <strong>{formatNumber(summary.humanKills)}</strong>
          </div>
        </div>
      </div>

      <div className="table-wrap">
        <table className="matches-table">
          <thead>
            <tr>
              <th className="col-place">#</th>
              <th>Match</th>
              <th className="col-kills">Kills</th>
              <th className="col-assists">Assists</th>
              <th className="col-damage">Damage</th>
              <th className="col-survived">Survived</th>
              <th className="col-distance hide-md">Distance</th>
              <th className="col-expand" aria-label="Open match" />
            </tr>
          </thead>
          <tbody>
            {matches.map((match) => {
              const openMatch = () => {
                navigate(
                  `/player/${encodeURIComponent(shard)}/${encodeURIComponent(playerName)}/match/${encodeURIComponent(match.id)}`,
                )
              }
              const botKills = match.killEvents.filter((kill) => kill.victimIsBot).length
              return (
                <tr
                  key={match.id}
                  className="match-row"
                  onClick={openMatch}
                  tabIndex={0}
                  role="button"
                  aria-label={`Open match details for ${match.mapLabel} on ${formatDateTime(match.createdAt)}`}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      openMatch()
                    }
                  }}
                >
                  <td className="col-place">
                    <span className={placementClass(match.placement)}>
                      {match.placement === 1 ? 'W' : match.placement ? match.placement : '—'}
                    </span>
                  </td>
                  <td>
                    <div className="match-main">
                      <span className={`map-badge ${mapClass(match.mapName)}`}>
                        {match.mapLabel}
                      </span>
                      <span className="match-mode">{match.modeLabel}</span>
                    </div>
                    <span className="match-date">
                      {formatDateTime(match.createdAt)} · {formatDuration(match.duration)}
                    </span>
                  </td>
                  <td className="col-kills strong">
                    {match.kills}
                    {match.killDataFetched && botKills > 0 ? (
                      <span className="bot-mark" title={`${botKills} bot kill${botKills === 1 ? '' : 's'}`}>
                        {botKills} BOT
                      </span>
                    ) : null}
                  </td>
                  <td className="col-assists">{match.assists}</td>
                  <td className="col-damage strong">{formatNumber(match.damage, 0)}</td>
                  <td className="col-survived">{formatDuration(match.timeSurvived)}</td>
                  <td className="col-distance hide-md">{formatDistance(match.walkDistance + match.rideDistance)}</td>
                  <td className="col-expand">
                    <svg viewBox="0 0 24 24" aria-hidden="true" className="chevron">
                      <path d="M8.6 5.6a1 1 0 0 1 1.4 0l6 6a1 1 0 0 1 0 1.4l-6 6a1 1 0 1 1-1.4-1.4L14 12 8.6 7a1 1 0 0 1 0-1.4Z" fill="currentColor" />
                    </svg>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="matches-footer">
        <span>
          Loaded {matches.length} of {total} stored match details
          {loadMoreError ? <span className="load-more-error"> · {loadMoreError}</span> : null}
        </span>
        {matches.length < total ? (
          <button
            type="button"
            className="button button-ghost load-more-button"
            onClick={onLoadMore}
            disabled={loadingMore}
          >
            {loadingMore ? 'Loading…' : `Load ${Math.min(total - matches.length, pageSize)} more`}
          </button>
        ) : (
          <span className="muted">All stored details loaded</span>
        )}
      </div>
    </section>
  )
}
