const MAP_CLASS: Record<string, string> = {
  Baltic_Main: 'map-erangel',
  Erangel_Main: 'map-erangel',
  Desert_Main: 'map-miramar',
  Savage_Main: 'map-sanhok',
  DihorOtok_Main: 'map-vikendi',
  Summerland_Main: 'map-karakin',
  Chimera_Main: 'map-paramo',
  Heaven_Main: 'map-haven',
  Tiger_Main: 'map-taego',
  Kiki_Main: 'map-deston',
  Neon_Main: 'map-rondo',
}

export function mapClass(mapName: string): string {
  return MAP_CLASS[mapName] ?? 'map-default'
}
