import { useCallback, useEffect, useRef, useState } from 'react'
import type { CrawlingResponse, JobSummary, ProfileResponse } from '@pubgstats/shared'
import { getProfile, refreshProfile } from './api'

export interface ProfileState {
  profile: ProfileResponse | null
  job: JobSummary | null
  error: { title: string; message: string; hint?: string } | null
  loading: boolean
  crawling: boolean
  refresh: () => Promise<void>
}

function jobFromCrawling(payload: CrawlingResponse): JobSummary {
  return payload.job
}

export function usePlayerProfile(shard: string, name: string): ProfileState {
  const [profile, setProfile] = useState<ProfileResponse | null>(null)
  const [job, setJob] = useState<JobSummary | null>(null)
  const [error, setError] = useState<ProfileState['error']>(null)
  const [loading, setLoading] = useState(true)
  const [crawling, setCrawling] = useState(false)
  const mounted = useRef(true)
  const inFlight = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const load = useCallback(
    async (initial = false) => {
      if (inFlight.current) return
      inFlight.current = true
      if (initial) setLoading(true)

      const result = await getProfile(shard, name)
      if (!mounted.current) {
        inFlight.current = false
        return
      }

      if (result.kind === 'profile') {
        setProfile(result.profile)
        setError(null)
        if (result.profile.crawl.job) setJob(result.profile.crawl.job)
        const active =
          result.profile.crawl.state === 'running' || result.profile.crawl.state === 'queued'
        setCrawling(active)
        if (!active && result.profile.crawl.state === 'idle') setJob(null)
        if (result.profile.crawl.state === 'failed') {
          setError({
            title: 'Last crawl failed',
            message: result.profile.crawl.job?.error ?? 'The crawler could not refresh this player.',
            hint: 'Try refreshing. If it keeps failing, check the crawler logs.',
          })
        }
      } else if (result.kind === 'crawling') {
        if (result.payload.player) {
          // Keep whatever profile we have; the next poll fills the stats in.
        }
        setJob(jobFromCrawling(result.payload))
        setCrawling(true)
        setError(null)
      } else if (result.kind === 'notFound') {
        setJob(result.payload.job ?? null)
        setCrawling(false)
        setProfile(null)
        setError({
          title: 'Player not found',
          message: result.payload.message,
          hint:
            result.payload.hint ??
            'PUBG player names are case-sensitive. Check the exact capitalization and platform.',
        })
      } else if (result.kind === 'cooldown') {
        setError({ title: 'Refresh cooldown', message: result.message })
        setCrawling(false)
      } else {
        setError({
          title: result.status === 503 ? 'Database is warming up' : 'Something went wrong',
          message: result.message,
          hint: result.hint,
        })
        setCrawling(false)
      }

      setLoading(false)
      inFlight.current = false
    },
    [shard, name],
  )

  useEffect(() => {
    setProfile(null)
    setJob(null)
    setError(null)
    setCrawling(false)
    setLoading(true)
    void load(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shard, name])

  useEffect(() => {
    if (!crawling) return
    const timer = window.setInterval(() => {
      void load(false)
    }, 1200)
    return () => window.clearInterval(timer)
  }, [crawling, load])

  const refresh = useCallback(async () => {
    if (crawling) return
    const result = await refreshProfile(shard, name)
    if (!mounted.current) return
    if (result.kind === 'crawling') {
      setJob(jobFromCrawling(result.payload))
      setCrawling(true)
      setError(null)
    } else if (result.kind === 'cooldown') {
      // The profile carries the authoritative cooldown timestamp; refresh it
      // so the button switches to its countdown.
      void load(false)
    } else if (result.kind === 'error') {
      setError({ title: 'Refresh failed', message: result.message, hint: result.hint })
    }
  }, [crawling, name, shard, load])

  return { profile, job, error, loading, crawling, refresh }
}
