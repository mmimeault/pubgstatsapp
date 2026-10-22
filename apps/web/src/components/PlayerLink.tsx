import { Link } from 'react-router-dom'

export function PlayerLink({
  name,
  isBot,
  shard,
  className,
}: {
  name: string | null
  isBot: boolean
  shard: string
  className?: string
}) {
  if (!name) return <span className={className}>Unknown</span>
  if (isBot) return <span className={className}>{name}</span>
  return (
    <Link
      className={className ? `player-link ${className}` : 'player-link'}
      to={`/player/${encodeURIComponent(shard)}/${encodeURIComponent(name)}`}
      title={`Open ${name}'s profile`}
    >
      {name}
    </Link>
  )
}
