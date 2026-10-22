import type {
  CrawlingResponse,
  JobSummary,
  MatchDetailResponse,
  MatchesPageResponse,
  NotFoundResponse,
  ProfileResponse,
  SeasonListResponse,
  SeasonStatsResponse,
} from '@pubgstats/shared'

export type ApiResult =
  | { kind: 'profile'; profile: ProfileResponse }
  | { kind: 'crawling'; payload: CrawlingResponse }
  | { kind: 'notFound'; payload: NotFoundResponse }
  | { kind: 'cooldown'; retryAfterSeconds: number; message: string }
  | { kind: 'error'; status: number; message: string; hint?: string }

export type MatchesPageResult =
  | { kind: 'matches'; page: MatchesPageResponse }
  | { kind: 'error'; message: string }

export type SeasonStatsResult =
  | { kind: 'season'; data: SeasonStatsResponse }
  | { kind: 'crawling'; job: JobSummary; seasonId: string }
  | { kind: 'notFound'; message: string }
  | { kind: 'error'; message: string }

async function parseError(response: Response): Promise<{ message: string; hint?: string }> {
  try {
    const body = (await response.json()) as { message?: string; hint?: string }
    return {
      message: body.message ?? `Request failed with status ${response.status}.`,
      hint: body.hint,
    }
  } catch {
    return { message: `Request failed with status ${response.status}.` }
  }
}

export async function getProfile(shard: string, name: string): Promise<ApiResult> {
  let response: Response
  try {
    response = await fetch(`/api/players/${encodeURIComponent(shard)}/${encodeURIComponent(name)}`, {
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    return {
      kind: 'error',
      status: 0,
      message: 'Could not reach the API. Is it running on port 3001?',
      hint: 'Run `make dev` from the project root.',
    }
  }

  if (response.status === 200) {
    return { kind: 'profile', profile: (await response.json()) as ProfileResponse }
  }
  if (response.status === 202) {
    return { kind: 'crawling', payload: (await response.json()) as CrawlingResponse }
  }
  if (response.status === 404) {
    return { kind: 'notFound', payload: (await response.json()) as NotFoundResponse }
  }

  const error = await parseError(response)
  return { kind: 'error', status: response.status, ...error }
}

export async function refreshProfile(shard: string, name: string): Promise<ApiResult> {
  let response: Response
  try {
    response = await fetch(
      `/api/players/${encodeURIComponent(shard)}/${encodeURIComponent(name)}/refresh`,
      { method: 'POST', signal: AbortSignal.timeout(15_000) },
    )
  } catch {
    return {
      kind: 'error',
      status: 0,
      message: 'Could not reach the API. Is it running on port 3001?',
    }
  }

  if (response.status === 202) {
    return { kind: 'crawling', payload: (await response.json()) as CrawlingResponse }
  }
  if (response.status === 429) {
    let retryAfterSeconds = Number(response.headers.get('retry-after')) || 60
    let message = `Refresh available in ${retryAfterSeconds}s.`
    try {
      const body = (await response.json()) as {
        retryAfterSeconds?: number
        message?: string
      }
      if (body.retryAfterSeconds) retryAfterSeconds = body.retryAfterSeconds
      if (body.message) message = body.message
    } catch {
      // keep header fallback
    }
    return { kind: 'cooldown', retryAfterSeconds, message }
  }
  const error = await parseError(response)
  return { kind: 'error', status: response.status, ...error }
}

export async function getMatchesPage(
  shard: string,
  name: string,
  limit: number,
  offset: number,
): Promise<MatchesPageResult> {
  const url = `/api/players/${encodeURIComponent(shard)}/${encodeURIComponent(name)}/matches?limit=${limit}&offset=${offset}`
  let response: Response
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  } catch {
    return { kind: 'error', message: 'Could not reach the API while loading more matches.' }
  }

  if (!response.ok) {
    const error = await parseError(response)
    return { kind: 'error', message: error.message }
  }

  return { kind: 'matches', page: (await response.json()) as MatchesPageResponse }
}

export type MatchDetailResult =
  | { kind: 'match'; detail: MatchDetailResponse }
  | { kind: 'notFound'; message: string }
  | { kind: 'error'; message: string }

export async function getMatchDetail(
  shard: string,
  name: string,
  matchId: string,
): Promise<MatchDetailResult> {
  const url = `/api/players/${encodeURIComponent(shard)}/${encodeURIComponent(name)}/matches/${encodeURIComponent(matchId)}`
  let response: Response
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  } catch {
    return { kind: 'error', message: 'Could not reach the API while loading the match.' }
  }

  if (response.status === 200) {
    return { kind: 'match', detail: (await response.json()) as MatchDetailResponse }
  }
  if (response.status === 404) {
    const body = (await response.json()) as { message?: string }
    return {
      kind: 'notFound',
      message: body.message ?? 'That match is not available for this player.',
    }
  }

  const error = await parseError(response)
  return { kind: 'error', message: error.message }
}

export async function getSeasons(
  shard: string,
  name: string,
): Promise<SeasonListResponse | null> {
  try {
    const response = await fetch(
      `/api/players/${encodeURIComponent(shard)}/${encodeURIComponent(name)}/seasons`,
      { signal: AbortSignal.timeout(15_000) },
    )
    if (!response.ok) return null
    return (await response.json()) as SeasonListResponse
  } catch {
    return null
  }
}

export async function getSeasonStats(
  shard: string,
  name: string,
  seasonId: string,
): Promise<SeasonStatsResult> {
  const url = `/api/players/${encodeURIComponent(shard)}/${encodeURIComponent(name)}/seasons/${encodeURIComponent(seasonId)}`
  let response: Response
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  } catch {
    return { kind: 'error', message: 'Could not reach the API while loading the season.' }
  }

  if (response.status === 200) {
    return { kind: 'season', data: (await response.json()) as SeasonStatsResponse }
  }
  if (response.status === 202) {
    const body = (await response.json()) as {
      seasonId: string
      job: JobSummary
    }
    return { kind: 'crawling', job: body.job, seasonId: body.seasonId }
  }
  if (response.status === 404) {
    const body = (await response.json()) as { message?: string }
    return {
      kind: 'notFound',
      message: body.message ?? 'No stats are available for this season.',
    }
  }

  const error = await parseError(response)
  return { kind: 'error', message: error.message }
}
