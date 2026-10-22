import { describe, expect, it } from 'vitest'
import { migrate, openDb } from '../../crawler/src/db'
import { buildMatchDetail } from '../src/matches'
import type { PlayerRow } from '../src/types'

const matchId = '11111111-1111-1111-1111-111111111111'

function setup() {
  const db = openDb(':memory:')
  migrate(db)
  const now = new Date('2026-10-19T12:00:00.000Z').toISOString()
  db.prepare(
    `INSERT INTO players (id, shard, name, name_folded, ban_type, clan_id, is_tracked, created_at, updated_at, last_synced_at)
     VALUES ('account.test', 'steam', 'TestPlayer', 'testplayer', 'Innocent', NULL, 1, ?, ?, ?)`,
  ).run(now, now, now)

  db.prepare(
    `INSERT INTO matches
       (id, shard, map_name, game_mode, match_type, duration, created_at, season_state, raw_json, fetched_at, telemetry_fetched_at)
     VALUES (?, 'steam', 'Baltic_Main', 'duo-fpp', 'official', 1500, ?, 'progress', NULL, ?, ?)`,
  ).run(matchId, '2026-10-19T10:00:00.000Z', now, now)

  const insertParticipant = db.prepare(
    `INSERT INTO match_participants
       (match_id, player_id, shard, name, placement, kills, headshots, assists, dbno, damage,
        time_survived, walk_distance, ride_distance, death_type, team_id, is_bot)
     VALUES (?, ?, 'steam', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  insertParticipant.run(matchId, 'account.test', 'TestPlayer', 1, 6, 2, 2, 1, 700.4, 1400, 2000, 400, 'alive', 7, 0)
  insertParticipant.run(matchId, 'account.mate', 'Mate', 1, 2, 1, 1, 0, 300.2, 1200, 1800, 300, 'alive', 7, 0)
  insertParticipant.run(matchId, 'ai.2', 'BotKiller', 3, 4, 1, 0, 2, 500, 1300, 1500, 500, 'alive', 9, 1)

  const insertKill = db.prepare(
    `INSERT INTO match_kills
       (match_id, event_time, killer_id, killer_name, killer_is_bot, victim_id, victim_name,
        victim_is_bot, weapon, damage_reason, distance, finisher_name, is_suicide, is_teamkill)
     VALUES (?, ?, 'account.test', 'TestPlayer', 0, ?, ?, ?, ?, 'TorsoShot', ?, NULL, 0, 0)`,
  )
  insertKill.run(matchId, '2026-10-19T10:05:00.000Z', 'ai.1', 'BotOne', 1, 'WeapM24_C', 63.5)
  insertKill.run(matchId, '2026-10-19T10:10:00.000Z', 'account.human', 'HumanVictim', 0, 'WeapHK416_C', 12.4)
  db.prepare(
    `INSERT INTO match_kills
       (match_id, event_time, killer_id, killer_name, killer_is_bot, victim_id, victim_name,
        victim_is_bot, weapon, damage_reason, distance, finisher_name, is_suicide, is_teamkill)
     VALUES (?, ?, 'ai.2', 'BotKiller', 1, 'account.test', 'TestPlayer', 0, 'WeapUMP_C', 'TorsoShot', 8.0, NULL, 0, 0)`,
  ).run(matchId, '2026-10-19T10:20:00.000Z')

  const player = db.prepare("SELECT * FROM players WHERE id = 'account.test'").get() as PlayerRow
  return { db, player }
}

describe('buildMatchDetail', () => {
  it('builds the banner, full lobby, my kills and teammate stats', () => {
    const { db, player } = setup()
    const detail = buildMatchDetail(db, player, matchId)

    expect(detail).not.toBeNull()
    expect(detail?.match).toMatchObject({
      mapLabel: 'Erangel',
      modeLabel: 'Duo FPP',
      killDataFetched: true,
      duration: 1500,
    })
    expect(detail?.me).toMatchObject({
      name: 'TestPlayer',
      placement: 1,
      kills: 6,
      damage: 700.4,
      isMe: true,
      isTeammate: false,
    })
    expect(detail?.teammates).toHaveLength(1)
    expect(detail?.teammates[0]).toMatchObject({
      id: 'account.mate',
      isTeammate: true,
      kills: 2,
    })
    expect(detail?.participants.map((p) => p.id)).toEqual([
      'account.test',
      'account.mate',
      'ai.2',
    ])
    expect(detail?.myKills).toHaveLength(2)
    expect(detail?.myKills[0]).toMatchObject({
      victimName: 'BotOne',
      victimIsBot: true,
      victimPlacement: null,
      weaponLabel: 'M24',
      distance: 63.5,
    })
    expect(detail?.myKills[1]).toMatchObject({
      victimName: 'HumanVictim',
      victimPlacement: null,
      weaponLabel: 'HK416',
    })
    expect(detail?.kills).toHaveLength(3)
    expect(detail?.death).toMatchObject({
      killerName: 'BotKiller',
      killerIsBot: true,
      killerPlacement: 3,
      victimPlacement: 1,
      weaponLabel: 'UMP45',
      distance: 8,
    })
    db.close()
  })

  it('returns null when the match is not stored for the player', () => {
    const { db, player } = setup()
    expect(buildMatchDetail(db, player, '22222222-2222-2222-2222-222222222222')).toBeNull()
    db.close()
  })
})
