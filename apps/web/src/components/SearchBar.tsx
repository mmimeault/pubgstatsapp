import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { SHARDS, SHARD_LABELS, type Shard } from '@pubgstats/shared'

interface SearchBarProps {
  defaultShard?: Shard
  defaultName?: string
  compact?: boolean
}

export function SearchBar({ defaultShard = 'steam', defaultName = '', compact = false }: SearchBarProps) {
  const navigate = useNavigate()
  const [shard, setShard] = useState<Shard>(defaultShard)
  const [name, setName] = useState(defaultName)

  function submit(event: FormEvent) {
    event.preventDefault()
    const value = name.trim()
    if (!value) return
    navigate(`/player/${shard}/${encodeURIComponent(value)}`)
  }

  return (
    <form className={compact ? 'search search-compact' : 'search'} onSubmit={submit} role="search">
      <select
        className="search-shard"
        aria-label="Platform"
        value={shard}
        onChange={(event) => setShard(event.target.value as Shard)}
      >
        {SHARDS.map((value) => (
          <option key={value} value={value}>
            {SHARD_LABELS[value]}
          </option>
        ))}
      </select>
      <span className="search-divider" aria-hidden="true" />
      <input
        className="search-input"
        type="search"
        name="player"
        placeholder="Enter your PUBG name"
        aria-label="PUBG player name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
      <button className="search-button" type="submit">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M10.5 3a7.5 7.5 0 0 1 5.9 12.1l4.3 4.3a1 1 0 0 1-1.4 1.4l-4.3-4.3A7.5 7.5 0 1 1 10.5 3Zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Z"
            fill="currentColor"
          />
        </svg>
        <span>Search</span>
      </button>
    </form>
  )
}
