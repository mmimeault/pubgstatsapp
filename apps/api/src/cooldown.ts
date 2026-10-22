export interface RefreshCooldown {
  availableAt: string | null
  remainingSeconds: number
}

/**
 * A player can be refreshed once per cooldown window. The window starts from
 * the most recent activity: successful sync completion or the latest crawl
 * request (which also covers failed attempts).
 */
export function computeRefreshCooldown(
  lastSyncedAt: string | null,
  latestJobCreatedAt: string | null,
  cooldownSeconds: number,
  now = Date.now(),
): RefreshCooldown {
  const timestamps = [lastSyncedAt, latestJobCreatedAt]
    .filter((value): value is string => Boolean(value))
    .map((value) => new Date(value).getTime())
    .filter((value) => Number.isFinite(value))

  if (timestamps.length === 0) {
    return { availableAt: null, remainingSeconds: 0 }
  }

  const availableAtMs = Math.max(...timestamps) + cooldownSeconds * 1000
  return {
    availableAt: new Date(availableAtMs).toISOString(),
    remainingSeconds: Math.max(0, Math.ceil((availableAtMs - now) / 1000)),
  }
}
