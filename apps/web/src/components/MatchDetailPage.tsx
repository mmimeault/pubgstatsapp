import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type {
  MatchDeathDetail,
  MatchDetailResponse,
  MatchKillDetail,
  MatchParticipantDetail,
} from '@pubgstats/shared'
import {
  formatDateTime,
  formatDistance,
  formatDuration,
  formatMatchClock,
  formatNumber,
  shardLabel,
} from '@pubgstats/shared'
import { getMatchDetail } from '../api'
import { mapClass } from '../mapClass'
import { PlayerLink } from './PlayerLink'

type MatchTab = 'kills' | 'rank' | 'details'

const DEATH_TYPE_LABELS: Record<string, string> = {
  byplayer: 'Killed by player',
  bybot: 'Killed by bot',
  byzone: 'Blue zone',
  suicide: 'Suicide',
  logout: 'Disconnected',
  alive: 'Alive',
}

function placementClass(placement: number | null): string {
  if (placement === 1) return 'placement placement-win'
  if (placement !== null && placement > 0 && placement <= 10) {
    return 'placement placement-top'
  }
  return 'placement'
}

function placementText(placement: number | null): string {
  if (placement === null || placement <= 0) return '—'
  return placement === 1 ? 'W' : String(placement)
}

function outcomeText(placement: number | null): string {
  if (placement === 1) return 'Chicken dinner'
  if (placement !== null && placement > 0 && placement <= 10) return 'Top 10 finish'
  if (placement !== null && placement > 0) return 'Match complete'
  return 'Unranked'
}

function deathTypeLabel(deathType: string | null): string {
  if (!deathType) return 'Unknown'
  return DEATH_TYPE_LABELS[deathType] ?? deathType
}

function MatchBanner({ detail }: { detail: MatchDetailResponse }) {
  const { match, me, player, myKills } = detail
  const botKills = myKills.filter((kill) => kill.victimIsBot).length
  const humanKills = myKills.length - botKills
  const profilePath = `/player/${encodeURIComponent(player.shard)}/${encodeURIComponent(player.name)}`

  return (
    <section className="panel match-banner">
      <div className="match-banner-top">
        <div className="match-banner-context">
          <span className="match-banner-kicker">
            <span className={`map-badge ${mapClass(match.mapName)}`}>{match.mapLabel}</span>
            <span className="dot-sep" aria-hidden="true" />
            <span>{match.modeLabel}</span>
            <span className="dot-sep" aria-hidden="true" />
            <span>{formatDateTime(match.createdAt)}</span>
          </span>
          <div className="match-banner-player">
            <span className="match-banner-name">{player.name}</span>
            <span className="tag tag-human">YOU</span>
            <span className="match-banner-duration">{formatDuration(match.duration)} match</span>
          </div>
        </div>
        <Link className="button button-ghost" to={profilePath}>
          ← Back to profile
        </Link>
      </div>

      <div className="match-banner-body">
        <div className="match-result-block">
          <span className="match-result-kicker">{outcomeText(me.placement)}</span>
          <span className={`match-result-place ${placementClass(me.placement)}`}>
            {me.placement === 1 ? 'W' : me.placement ? `#${me.placement}` : '—'}
          </span>
          <span className="match-result-sub">
            {me.teamId !== null ? `Team ${me.teamId}` : 'Solo placement'}
          </span>
        </div>

        <div className="match-banner-stats">
          <div>
            <span>Kills</span>
            <strong>{formatNumber(me.kills)}</strong>
            <em>
              {botKills} bot · {humanKills} player
            </em>
          </div>
          <div>
            <span>Damage</span>
            <strong>{formatNumber(me.damage, 0)}</strong>
          </div>
          <div>
            <span>Assists</span>
            <strong>{formatNumber(me.assists)}</strong>
          </div>
          <div>
            <span>DBNO</span>
            <strong>{formatNumber(me.dbno)}</strong>
          </div>
          <div>
            <span>Survived</span>
            <strong>{formatDuration(me.timeSurvived)}</strong>
          </div>
          <div>
            <span>Headshots</span>
            <strong>{formatNumber(me.headshots)}</strong>
          </div>
          <div>
            <span>Distance</span>
            <strong>{formatDistance(me.walkDistance + me.rideDistance)}</strong>
          </div>
        </div>
      </div>
    </section>
  )
}

function KillRow({
  kill,
  index,
  matchStart,
  shard,
}: {
  kill: MatchKillDetail
  index: number
  matchStart: string
  shard: string
}) {
  return (
    <li className="match-kill-row">
      <span className="match-kill-index">{String(index + 1).padStart(2, '0')}</span>
      <span className="match-kill-time">
        {formatMatchClock(kill.eventTime, matchStart) || '--:--'}
      </span>
      <div className="match-kill-copy">
        <div className="match-kill-victim">
          <PlayerLink
            name={kill.victimName}
            isBot={kill.victimIsBot}
            shard={shard}
            className="match-kill-name"
          />
          <span className={kill.victimIsBot ? 'tag tag-bot' : 'tag tag-human'}>
            {kill.victimIsBot ? 'BOT' : 'PLAYER'}
          </span>
          {kill.isTeamkill ? <span className="tag tag-team">TEAM</span> : null}
          {kill.isSuicide ? <span className="tag tag-team">SUICIDE</span> : null}
          {kill.victimPlacement !== null ? (
            <span className="match-kill-rank" title="Victim's team placement">
              #{kill.victimPlacement}
            </span>
          ) : null}
        </div>
        <div className="match-kill-meta">
          <span className="match-kill-weapon">{kill.weaponLabel}</span>
          {kill.distance !== null ? (
            <span>{formatDistance(kill.distance)}</span>
          ) : null}
          {kill.finisherName ? <span>finished by {kill.finisherName}</span> : null}
        </div>
      </div>
    </li>
  )
}

function DeathCard({ detail }: { detail: MatchDetailResponse }) {
  const { death, me, match } = detail
  const profile = detail.player

  if (!death) {
    const won = me.placement === 1
    return (
      <section className="panel match-side-card match-death-card">
        <span className="match-card-kicker">Your match</span>
        <h3>{won ? 'Chicken dinner' : match.killDataFetched ? 'Survived' : 'Death not indexed'}</h3>
        <p className="match-side-copy">
          {won
            ? 'You survived the match and took the win.'
            : match.killDataFetched
              ? 'No death event appears in the indexed telemetry.'
              : match.telemetryError
                ? `Telemetry is unavailable: ${match.telemetryError}`
                : 'Kill telemetry has not been indexed for this match yet.'}
        </p>
        <div className="match-death-facts">
          <div>
            <span>Placement</span>
            <strong>{me.placement ? `#${me.placement}` : '—'}</strong>
          </div>
          <div>
            <span>Survived</span>
            <strong>{formatDuration(me.timeSurvived)}</strong>
          </div>
          <div>
            <span>Death type</span>
            <strong>{deathTypeLabel(me.deathType)}</strong>
          </div>
        </div>
        <Link className="match-inline-link" to={`/player/${encodeURIComponent(profile.shard)}/${encodeURIComponent(profile.name)}`}>
          View {profile.name}'s profile →
        </Link>
      </section>
    )
  }

  return (
    <section className="panel match-side-card match-death-card">
      <span className="match-card-kicker">Your match</span>
      <h3>You were eliminated</h3>
      <div className="match-death-line">
        <span className="match-death-mark" aria-hidden="true">
          ×
        </span>
        <div>
          <span className="match-death-label">
            {death.isSuicide ? 'You eliminated yourself' : 'Killed by'}
          </span>
          {death.isSuicide ? (
            <strong>Self</strong>
          ) : death.killerName ? (
            <strong className="match-death-killer">
              <PlayerLink
                name={death.killerName}
                isBot={death.killerIsBot}
                shard={detail.player.shard}
              />
              <span className={death.killerIsBot ? 'tag tag-bot' : 'tag tag-human'}>
                {death.killerIsBot ? 'BOT' : 'PLAYER'}
              </span>
              {death.isTeamkill ? <span className="tag tag-team">TEAM</span> : null}
            </strong>
          ) : (
            <strong>Environment</strong>
          )}
        </div>
      </div>
      <div className="match-death-facts">
        <div>
          <span>Weapon</span>
          <strong>{death.weaponLabel}</strong>
        </div>
        <div>
          <span>Distance</span>
          <strong>{death.distance !== null ? formatDistance(death.distance) : '—'}</strong>
        </div>
        <div>
          <span>At</span>
          <strong>{formatMatchClock(death.eventTime, match.createdAt) || '--:--'}</strong>
        </div>
        <div>
          <span>Killer place</span>
          <strong>{death.killerPlacement !== null ? `#${death.killerPlacement}` : '—'}</strong>
        </div>
      </div>
      <Link className="match-inline-link" to={`/player/${encodeURIComponent(profile.shard)}/${encodeURIComponent(profile.name)}`}>
        View {profile.name}'s profile →
      </Link>
    </section>
  )
}

function KillMapCard({ detail }: { detail: MatchDetailResponse }) {
  return (
    <section className="panel match-side-card match-map-card">
      <div className="match-map-head">
        <span className="match-card-kicker">Map view</span>
        <span className={`map-badge ${mapClass(detail.match.mapName)}`}>{detail.match.mapLabel}</span>
      </div>
      <div className="match-map-canvas">
        <span className="match-map-pin" aria-hidden="true">
          +
        </span>
        <span className="match-map-label">Kill positions</span>
      </div>
      <p className="match-side-copy">
        Kill pins aren't indexed yet. The kill feed is ready; this panel will show your kills and
        death on the map once telemetry coordinates are stored.
      </p>
    </section>
  )
}

function KillsTab({ detail }: { detail: MatchDetailResponse }) {
  const { match, myKills } = detail
  const botKills = myKills.filter((kill) => kill.victimIsBot).length
  const humanKills = myKills.length - botKills

  return (
    <div className="match-kill-layout">
      <section className="panel match-card match-kill-card">
        <div className="match-card-head">
          <div>
            <span className="match-card-kicker">Timeline</span>
            <h2>My kills</h2>
            <p>
              {match.killDataFetched
                ? `${myKills.length} kill${myKills.length === 1 ? '' : 's'} in this match`
                : 'Kill details are waiting on telemetry.'}
            </p>
          </div>
          {match.killDataFetched ? (
            <div className="kill-split">
              <div>
                <span>Player</span>
                <strong>{humanKills}</strong>
              </div>
              <div>
                <span>Bot</span>
                <strong>{botKills}</strong>
              </div>
            </div>
          ) : null}
        </div>

        {!match.killDataFetched ? (
          <div className="match-empty-state">
            <strong>Kill data not indexed</strong>
            <p>
              {match.telemetryError
                ? match.telemetryError
                : 'Refresh this player to crawl the telemetry for this match.'}
            </p>
          </div>
        ) : myKills.length === 0 ? (
          <div className="match-empty-state">
            <strong>No kills this match.</strong>
            <p>You didn't finish an opponent in this run.</p>
          </div>
        ) : (
          <ol className="match-kill-list">
            {myKills.map((kill, index) => (
              <KillRow
                key={`${kill.eventTime}-${kill.victimId ?? index}`}
                kill={kill}
                index={index}
                matchStart={match.createdAt}
                shard={detail.player.shard}
              />
            ))}
          </ol>
        )}
      </section>

      <div className="match-side-stack">
        <DeathCard detail={detail} />
        <KillMapCard detail={detail} />
      </div>
    </div>
  )
}

function RankTab({ detail }: { detail: MatchDetailResponse }) {
  const { participants } = detail

  return (
    <section className="panel match-card rank-card">
      <div className="match-card-head">
        <div>
          <span className="match-card-kicker">Lobby</span>
          <h2>Total rank</h2>
          <p>
            All {participants.length} players · sorted by team placement, then kills
          </p>
        </div>
        <div className="rank-legend">
          <span><i className="legend-dot legend-me" /> You</span>
          <span><i className="legend-dot legend-team" /> Team</span>
          <span><i className="legend-dot legend-bot" /> Bot</span>
        </div>
      </div>

      <div className="table-wrap">
        <table className="match-rank-table">
          <thead>
            <tr>
              <th className="rank-place">Place</th>
              <th>Player</th>
              <th className="rank-team">Team</th>
              <th className="rank-num">Kills</th>
              <th className="rank-num">Damage</th>
              <th className="rank-num rank-optional">Assists</th>
              <th className="rank-num rank-optional">DBNO</th>
              <th className="rank-num">Survived</th>
              <th className="rank-num rank-optional">HS</th>
            </tr>
          </thead>
          <tbody>
            {participants.map((participant) => (
              <RankRow
                key={participant.id}
                participant={participant}
                shard={detail.player.shard}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function RankRow({
  participant,
  shard,
}: {
  participant: MatchParticipantDetail
  shard: string
}) {
  const rowClass = participant.isMe
    ? 'rank-row rank-row-me'
    : participant.isTeammate
      ? 'rank-row rank-row-team'
      : participant.isBot
        ? 'rank-row rank-row-bot'
        : 'rank-row'

  return (
    <tr className={rowClass}>
      <td className="rank-place">
        <span className={placementClass(participant.placement)}>
          {placementText(participant.placement)}
        </span>
      </td>
      <td>
        <div className="rank-player">
          <PlayerLink
            name={participant.name}
            isBot={participant.isBot}
            shard={shard}
            className="rank-player-name"
          />
          {participant.isMe ? <span className="tag tag-human">YOU</span> : null}
          {participant.isTeammate ? <span className="tag tag-team">TEAM</span> : null}
          {participant.isBot ? <span className="tag tag-bot">BOT</span> : null}
        </div>
      </td>
      <td className="rank-team">
        {participant.teamId !== null ? `Team ${participant.teamId}` : '—'}
      </td>
      <td className="rank-num strong">{participant.kills}</td>
      <td className="rank-num">{formatNumber(participant.damage, 0)}</td>
      <td className="rank-num rank-optional">{participant.assists}</td>
      <td className="rank-num rank-optional">{participant.dbno}</td>
      <td className="rank-num">{formatDuration(participant.timeSurvived)}</td>
      <td className="rank-num rank-optional">{participant.headshots}</td>
    </tr>
  )
}

function TeamRoster({ detail }: { detail: MatchDetailResponse }) {
  const roster = [detail.me, ...detail.teammates]
  const totals = roster.reduce(
    (acc, player) => ({
      kills: acc.kills + player.kills,
      damage: acc.damage + player.damage,
      assists: acc.assists + player.assists,
      dbno: acc.dbno + player.dbno,
      survived: acc.survived + player.timeSurvived,
    }),
    { kills: 0, damage: 0, assists: 0, dbno: 0, survived: 0 },
  )

  return (
    <section className="panel match-card team-roster-card">
      <div className="match-card-head">
        <div>
          <span className="match-card-kicker">Team performance</span>
          <h2>{detail.me.teamId !== null ? `Team ${detail.me.teamId}` : 'Your team'}</h2>
          <p>
            {detail.teammates.length > 0
              ? `${roster.length} players · ${detail.teammates.length} teammates`
              : 'No teammates in this match.'}
          </p>
        </div>
        <div className="team-totals">
          <div><span>Kills</span><strong>{totals.kills}</strong></div>
          <div><span>Damage</span><strong>{formatNumber(totals.damage, 0)}</strong></div>
          <div><span>Assists</span><strong>{totals.assists}</strong></div>
          <div><span>DBNO</span><strong>{totals.dbno}</strong></div>
        </div>
      </div>

      <div className="table-wrap">
        <table className="match-team-table">
          <thead>
            <tr>
              <th>Player</th>
              <th className="rank-num">Kills</th>
              <th className="rank-num">Damage</th>
              <th className="rank-num">Assists</th>
              <th className="rank-num">DBNO</th>
              <th className="rank-num">Survived</th>
              <th className="rank-num rank-optional">HS</th>
              <th className="rank-num rank-optional">Distance</th>
            </tr>
          </thead>
          <tbody>
            {roster.map((player) => (
              <tr key={player.id} className={player.isMe ? 'rank-row-me' : undefined}>
                <td>
                  <div className="rank-player">
                    <PlayerLink
                      name={player.name}
                      isBot={player.isBot}
                      shard={detail.player.shard}
                      className="rank-player-name"
                    />
                    {player.isMe ? <span className="tag tag-human">YOU</span> : null}
                    {player.isBot ? <span className="tag tag-bot">BOT</span> : null}
                  </div>
                </td>
                <td className="rank-num strong">{player.kills}</td>
                <td className="rank-num">{formatNumber(player.damage, 0)}</td>
                <td className="rank-num">{player.assists}</td>
                <td className="rank-num">{player.dbno}</td>
                <td className="rank-num">{formatDuration(player.timeSurvived)}</td>
                <td className="rank-num rank-optional">{player.headshots}</td>
                <td className="rank-num rank-optional">
                  {formatDistance(player.walkDistance + player.rideDistance)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function DetailsTab({ detail }: { detail: MatchDetailResponse }) {
  const { match, me } = detail

  return (
    <div className="match-details-grid">
      <TeamRoster detail={detail} />

      <section className="panel match-card match-meta-card">
        <span className="match-card-kicker">Match details</span>
        <h2>Lobby facts</h2>
        <div className="match-meta-grid">
          <div><span>Map</span><strong>{match.mapLabel}</strong></div>
          <div><span>Mode</span><strong>{match.modeLabel}</strong></div>
          <div><span>Match type</span><strong>{match.matchType}</strong></div>
          <div><span>Date</span><strong>{formatDateTime(match.createdAt)}</strong></div>
          <div><span>Duration</span><strong>{formatDuration(match.duration)}</strong></div>
          <div><span>Telemetry</span><strong>{match.killDataFetched ? 'Indexed' : 'Not indexed'}</strong></div>
          <div className="match-meta-wide">
            <span>Match ID</span>
            <code>{match.id}</code>
          </div>
          {match.telemetryError ? (
            <div className="match-meta-wide match-meta-warn">
              <span>Telemetry note</span>
              <strong>{match.telemetryError}</strong>
            </div>
          ) : null}
        </div>
      </section>

      <section className="panel match-card match-meta-card">
        <span className="match-card-kicker">Your numbers</span>
        <h2>Expanded stats</h2>
        <div className="match-meta-grid">
          <div><span>Placement</span><strong>{me.placement ? `#${me.placement}` : '—'}</strong></div>
          <div><span>Kills</span><strong>{me.kills}</strong></div>
          <div><span>Headshots</span><strong>{me.headshots}</strong></div>
          <div><span>Assists</span><strong>{me.assists}</strong></div>
          <div><span>DBNO</span><strong>{me.dbno}</strong></div>
          <div><span>Damage</span><strong>{formatNumber(me.damage, 1)}</strong></div>
          <div><span>Survived</span><strong>{formatDuration(me.timeSurvived)}</strong></div>
          <div><span>Death type</span><strong>{deathTypeLabel(me.deathType)}</strong></div>
          <div><span>Walked</span><strong>{formatDistance(me.walkDistance)}</strong></div>
          <div><span>Rode</span><strong>{formatDistance(me.rideDistance)}</strong></div>
          <div><span>Distance</span><strong>{formatDistance(me.walkDistance + me.rideDistance)}</strong></div>
        </div>
      </section>
    </div>
  )
}

export function MatchDetailPage() {
  const params = useParams<{ shard: string; name: string; matchId: string }>()
  const shard = params.shard ?? 'steam'
  const name = params.name ?? ''
  const matchId = params.matchId ?? ''
  const [detail, setDetail] = useState<MatchDetailResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<MatchTab>('kills')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setDetail(null)
    setTab('kills')
    void getMatchDetail(shard, name, matchId).then((result) => {
      if (cancelled) return
      if (result.kind === 'match') {
        setDetail(result.detail)
      } else {
        setError(result.message)
      }
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [shard, name, matchId])

  useEffect(() => {
    window.scrollTo({ top: 0 })
  }, [matchId])

  useEffect(() => {
    document.title = detail
      ? `${detail.match.mapLabel} · ${detail.me.kills} kills · PUBGSTATS`
      : 'Match detail · PUBGSTATS'
  }, [detail])

  const profilePath = `/player/${encodeURIComponent(shard)}/${encodeURIComponent(name)}`

  return (
    <main className="container profile-page match-page">
      <div className="match-toolbar">
        <div className="toolbar-context">
          <span className="context-label">Match detail</span>
          <span className="context-value">
            {shardLabel(shard)} · {name}
          </span>
        </div>
        <Link className="button button-ghost" to={profilePath}>
          Back to {name}
        </Link>
      </div>

      {loading ? (
        <section className="panel match-loading-card">
          <span className="season-spinner" />
          <div>
            <strong>Loading match</strong>
            <span>Reading the stored lobby, participants and kill feed…</span>
          </div>
        </section>
      ) : null}

      {!loading && error ? (
        <section className="panel match-error-card" role="alert">
          <strong>Match unavailable</strong>
          <p>{error}</p>
          <Link className="button button-ghost" to={profilePath}>
            Back to profile
          </Link>
        </section>
      ) : null}

      {detail ? (
        <>
          <MatchBanner detail={detail} />

          <div className="match-tabs" role="tablist" aria-label="Match detail sections">
            <button
              type="button"
              role="tab"
              id="match-tab-kills"
              aria-selected={tab === 'kills'}
              aria-controls="match-panel-kills"
              className={tab === 'kills' ? 'match-tab active' : 'match-tab'}
              onClick={() => setTab('kills')}
            >
              My kills <span className="match-tab-count">{detail.myKills.length}</span>
            </button>
            <button
              type="button"
              role="tab"
              id="match-tab-rank"
              aria-selected={tab === 'rank'}
              aria-controls="match-panel-rank"
              className={tab === 'rank' ? 'match-tab active' : 'match-tab'}
              onClick={() => setTab('rank')}
            >
              Total rank <span className="match-tab-count">{detail.participants.length}</span>
            </button>
            <button
              type="button"
              role="tab"
              id="match-tab-details"
              aria-selected={tab === 'details'}
              aria-controls="match-panel-details"
              className={tab === 'details' ? 'match-tab active' : 'match-tab'}
              onClick={() => setTab('details')}
            >
              Details
            </button>
          </div>

          <div
            id={`match-panel-${tab}`}
            role="tabpanel"
            aria-labelledby={`match-tab-${tab}`}
            className="match-tab-panel"
          >
            {tab === 'kills' ? <KillsTab detail={detail} /> : null}
            {tab === 'rank' ? <RankTab detail={detail} /> : null}
            {tab === 'details' ? <DetailsTab detail={detail} /> : null}
          </div>
        </>
      ) : null}
    </main>
  )
}
