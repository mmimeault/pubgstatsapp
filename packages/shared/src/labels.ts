const MAP_LABELS: Record<string, string> = {
  // Official dictionary: github.com/pubg/api-assets/.../mapName.json
  Baltic_Main: 'Erangel',
  Desert_Main: 'Miramar',
  Savage_Main: 'Sanhok',
  DihorOtok_Main: 'Vikendi',
  Summerland_Main: 'Karakin',
  Chimera_Main: 'Paramo',
  Heaven_Main: 'Haven',
  Tiger_Main: 'Taego',
  Kiki_Main: 'Deston',
  Neon_Main: 'Rondo',
  Erangel_Main: 'Erangel',
  Range_Main: 'Camp Jackal',
}

const MODE_LABELS: Record<string, string> = {
  solo: 'Solo',
  'solo-fpp': 'Solo FPP',
  duo: 'Duo',
  'duo-fpp': 'Duo FPP',
  squad: 'Squad',
  'squad-fpp': 'Squad FPP',
  'ranked-solo': 'Ranked Solo',
  'ranked-solo-fpp': 'Ranked Solo FPP',
  'ranked-duo': 'Ranked Duo',
  'ranked-duo-fpp': 'Ranked Duo FPP',
  'ranked-squad': 'Ranked Squad',
  'ranked-squad-fpp': 'Ranked Squad FPP',
  'crash-fpp': 'Crash FPP',
  'tdm': 'TDM',
}

export function mapLabel(mapName: string): string {
  if (MAP_LABELS[mapName]) return MAP_LABELS[mapName]
  return mapName
    .replace(/_Main$/, '')
    .replace(/_/g, ' ')
}

export function modeLabel(mode: string): string {
  if (MODE_LABELS[mode]) return MODE_LABELS[mode]
  return mode
    .split('-')
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(' ')
}

const WEAPON_LABELS: Record<string, string> = {
  WeapAK47_C: 'AK-47',
  WeapM416_C: 'M416',
  WeapM16A4_C: 'M16A4',
  'WeapSCAR-L_C': 'SCAR-L',
  WeapQBZ95_C: 'QBZ95',
  WeapG36C_C: 'G36C',
  WeapBerylM762_C: 'Beryl M762',
  WeapMk47Mutant_C: 'Mk47 Mutant',
  WeapACE32_C: 'ACE32',
  WeapRPD_C: 'RPD',
  WeapMP9_C: 'MP9',
  WeapL6_C: 'L6',
  WeapDragunov_C: 'Dragunov',
  WeapFNFal_C: 'SLR',
  WeapWinchester_C: 'Win94',
  WeapThompson_C: 'Tommy Gun',
  ProjGrenade_C: 'Frag Grenade',
  BP_MolotovFireDebuff_C: 'Molotov',
  TslGameModeBase_BattleRoyaleBP_C: 'Blue Zone',
  WeapGroza_C: 'Groza',
  WeapAUG_C: 'AUG',
  WeapM249_C: 'M249',
  WeapDP28_C: 'DP-28',
  WeapMG3_C: 'MG3',
  WeapM24_C: 'M24',
  WeapKar98k_C: 'Kar98k',
  WeapAWM_C: 'AWM',
  WeapMosin_C: 'Mosin-Nagant',
  WeapWin94_C: 'Win94',
  WeapSKS_C: 'SKS',
  WeapMini14_C: 'Mini 14',
  WeapMk14_C: 'Mk14',
  WeapVSS_C: 'VSS',
  WeapSLR_C: 'SLR',
  WeapQBU88_C: 'QBU88',
  WeapMk12_C: 'Mk12',
  WeapUMP_C: 'UMP45',
  WeapVector_C: 'Vector',
  WeapMP5K_C: 'MP5K',
  WeapP90_C: 'P90',
  WeapUZI_C: 'Micro UZI',
  WeapTommyGun_C: 'Tommy Gun',
  WeapBizon_C: 'Bizon',
  WeapSaiga12_C: 'Saiga 12',
  WeapBerreta686_C: 'S686',
  WeapS1897_C: 'S1897',
  WeapS12K_C: 'S12K',
  WeapDBS_C: 'DBS',
  WeapHK416_C: 'HK416',
  WeapPan_C: 'Pan',
  WeapCrowbar_C: 'Crowbar',
  WeapMachete_C: 'Machete',
  WeapSickle_C: 'Sickle',
}

/** Convert PUBG weapon assets such as WeapM24_C into a readable label. */
export function weaponLabel(weapon: string | null | undefined): string {
  if (!weapon) return 'Unknown'
  if (WEAPON_LABELS[weapon]) return WEAPON_LABELS[weapon]
  return weapon
    .replace(/^Weap/, '')
    .replace(/_C(?:_\d+)?$/, '')
    .replace(/_/g, ' ')
    .trim() || 'Unknown'
}

/** "division.bro.official.pc-2018-43" -> "Season 43" */
export function seasonLabel(seasonId: string): string {
  const match = seasonId.match(/pc-2018-(\d+)$/)
  if (match) return `Season ${match[1]}`
  const consoleMatch = seasonId.match(/console-(\d+)$/)
  if (consoleMatch) return `Season ${Number(consoleMatch[1])}`
  const parts = seasonId.split('.')
  return parts[parts.length - 1] || seasonId
}

export function seasonNumber(seasonId: string): number {
  const match = seasonId.match(/(?:pc-2018|console)-(\d+)$/)
  return match ? Number(match[1]) : -1
}

/** Modern seasons only, excluding 2017 beta/pre-seasons and cross-platform noise. */
export function isModernSeason(shard: string, seasonId: string): boolean {
  if (shard === 'steam' || shard === 'kakao') {
    return /pc-2018-\d+$/.test(seasonId)
  }
  return /console-\d+$/.test(seasonId) || /pc-2018-\d+$/.test(seasonId)
}

export function shardLabel(shard: string): string {
  const labels: Record<string, string> = {
    steam: 'Steam',
    kakao: 'Kakao',
    psn: 'PlayStation',
    xbox: 'Xbox',
  }
  return labels[shard] ?? shard
}
