/**
 * Hermes Achievements — desktop plugin (enhanced fork).
 *
 * Fork of asimons81/hermes-desktop-achievements (MIT) by Tony Simons.
 * Extensions on top of the original:
 *   - Unlock notifications: toast + haptic + chime + confetti the moment a
 *     new badge lands (poll diff against a persisted known set).
 *   - "Next up" strip: the locked achievements closest to unlocking.
 *   - Per-session context: badges earned in the active session.
 *   - Share cards: 1200×630 canvas PNG export per unlocked badge.
 *
 * Backed by the existing hermes-achievements dashboard plugin API
 * (mounted at /api/plugins/hermes-achievements/). Plain ESM loaded
 * uncompiled: UI is jsx() calls, NOT JSX syntax; only @hermes/plugin-sdk,
 * react, react/jsx-runtime resolve.
 */

import {
  Badge,
  Button,
  cn,
  Codicon,
  EmptyState,
  ErrorState,
  haptic,
  host,
  queryClient,
  relativeTime,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  PALETTE_AREA,
  STATUSBAR_AREAS,
  Skeleton,
  Tip,
  useQuery,
  useValue
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useEffect, useRef, useState } from 'react'

const ID = 'hermes-achievements'

// Assigned in register(ctx) — components can't see ctx directly.
let rest

const TIER_ORDER = ['Copper', 'Silver', 'Gold', 'Diamond', 'Olympian']
const FILTERS = ['all', 'unlocked', 'discovered', 'secret']
const UNLOCK_POLL_MS = 15_000

function tierIndex(tier) {
  return tier ? TIER_ORDER.indexOf(tier) : -1
}

function tierBadgeClass(tier) {
  const i = tierIndex(tier)
  if (i < 0) return 'text-(--ui-text-quaternary)'
  if (i >= 4) return 'text-(--ui-accent) font-semibold'
  if (i >= 3) return 'text-(--ui-accent)'
  if (i >= 2) return 'text-(--ui-text-primary)'
  return 'text-(--ui-text-secondary)'
}

function stateBadgeClass(state) {
  if (state === 'unlocked') return 'bg-(--ui-accent-muted) text-(--ui-accent)'
  if (state === 'secret') return 'text-(--ui-text-quaternary)'
  return 'text-(--ui-text-tertiary)'
}

function progressBarClass(state) {
  if (state === 'unlocked') return 'bg-(--ui-accent)'
  return 'bg-(--ui-text-tertiary)'
}

// ── Unlock watcher ─────────────────────────────────────────────────────────

let _known = new Map() // id -> { id, name, tier, unlocked_at }
let _baselineSet = false
let _watcherTimer = null
let _audioCtx = null

function playChime() {
  try {
    _audioCtx = _audioCtx || new (window.AudioContext || window.webkitAudioContext)()
    const ctx = _audioCtx
    const now = ctx.currentTime
    ;[660, 880].forEach((freq, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      const t = now + i * 0.12
      gain.gain.setValueAtTime(0.0001, t)
      gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.14)
      osc.connect(gain).connect(ctx.destination)
      osc.start(t)
      osc.stop(t + 0.16)
    })
  } catch (e) {
    /* audio unavailable — ignore */
  }
}

function lighten(hex, amt) {
  try {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex))
    if (!m) return hex
    const n = parseInt(m[1], 16)
    const f = c => Math.max(0, Math.min(255, Math.round(c + 255 * amt)))
    const r = f((n >> 16) & 255)
    const g = f((n >> 8) & 255)
    const b = f(n & 255)
    return `rgb(${r},${g},${b})`
  } catch (e) {
    return hex
  }
}

let _confettiCanvas = null
let _confettiRaf = null

function spawnConfetti() {
  try {
    if (_confettiCanvas) return // one burst at a time
    const canvas = document.createElement('canvas')
    canvas.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:9999'
    canvas.width = window.innerWidth * window.devicePixelRatio
    canvas.height = window.innerHeight * window.devicePixelRatio
    document.body.appendChild(canvas)
    const ctx = canvas.getContext('2d')
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio)

    const cs = getComputedStyle(document.body)
    const get = v => cs.getPropertyValue(v).trim() || null
    const accent = get('--ui-accent') || '#7B2D8E'
    const palette = [
      accent,
      lighten(accent, 0.35),
      lighten(accent, -0.25),
      get('--ui-text-primary') || '#ffffff',
      get('--ui-text-secondary') || '#b0b0b0'
    ]

    const W = window.innerWidth
    const H = window.innerHeight
    const parts = Array.from({ length: 150 }, () => ({
      x: W * (0.15 + Math.random() * 0.7),
      y: -20 - Math.random() * H * 0.5,
      w: 6 + Math.random() * 6,
      h: 10 + Math.random() * 8,
      vx: (Math.random() - 0.5) * 2.4,
      vy: 2.2 + Math.random() * 3.6,
      rot: Math.random() * Math.PI * 2,
      vr: (Math.random() - 0.5) * 0.25,
      color: palette[(Math.random() * palette.length) | 0],
      sway: Math.random() * Math.PI * 2,
      swaySpeed: 0.02 + Math.random() * 0.04
    }))

    const start = performance.now()
    const DURATION = 3200

    const tick = now => {
      const elapsed = now - start
      const t = Math.min(1, elapsed / DURATION)
      ctx.clearRect(0, 0, W, H)
      ctx.globalAlpha = 1 - t * t
      for (const p of parts) {
        p.sway += p.swaySpeed
        p.x += p.vx + Math.sin(p.sway) * 0.8
        p.y += p.vy
        p.rot += p.vr
        ctx.save()
        ctx.translate(p.x, p.y)
        ctx.rotate(p.rot)
        ctx.fillStyle = p.color
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h)
        ctx.restore()
      }
      if (t < 1) {
        _confettiRaf = requestAnimationFrame(tick)
      } else {
        ctx.clearRect(0, 0, W, H)
        canvas.remove()
        _confettiCanvas = null
        _confettiRaf = null
      }
    }

    _confettiCanvas = canvas
    _confettiRaf = requestAnimationFrame(tick)
  } catch (e) {
    /* confetti unavailable — ignore */
  }
}

function notifyUnlock(a) {
  try {
    haptic('tap')
  } catch (e) {
    /* ignore */
  }
  playChime()
  spawnConfetti()
  const tier = a.tier ? ` [${a.tier}]` : ''
  host.notify({ kind: 'success', message: `Achievement unlocked: ${a.name}${tier}` })
}

async function refreshUnlocks(ctx) {
  try {
    const data = await ctx.rest('/achievements', { timeoutMs: 8000 })
    const unlocked = (data?.achievements || []).filter(a => a.unlocked)
    if (!_baselineSet) {
      // First fetch: seed from storage so restarts don't re-toast old unlocks.
      let stored = []
      try {
        stored = (await ctx.storage.get('knownUnlocks')) || []
      } catch (e) {
        /* storage unavailable — treat as empty */
      }
      _known = new Map(stored.map(s => [s.id, s]))
      for (const a of unlocked) {
        if (!_known.has(a.id)) {
          _known.set(a.id, { id: a.id, name: a.name, tier: a.tier || null, unlocked_at: a.unlocked_at || Date.now() / 1000 })
        }
      }
      _baselineSet = true
      try {
        await ctx.storage.set('knownUnlocks', Array.from(_known.values()))
      } catch (e) {
        /* ignore */
      }
      return
    }
    let changed = false
    for (const a of unlocked) {
      if (!_known.has(a.id)) {
        _known.set(a.id, { id: a.id, name: a.name, tier: a.tier || null, unlocked_at: a.unlocked_at || Date.now() / 1000 })
        notifyUnlock(a)
        changed = true
      }
    }
    if (changed) {
      try {
        await ctx.storage.set('knownUnlocks', Array.from(_known.values()))
        await queryClient.invalidateQueries({ queryKey: ['hermes-achievements'] })
      } catch (e) {
        /* ignore */
      }
    }
  } catch (e) {
    /* transient — next tick retries */
  }
}

function startUnlockWatcher(ctx) {
  if (_watcherTimer) clearInterval(_watcherTimer)
  refreshUnlocks(ctx)
  _watcherTimer = setInterval(() => refreshUnlocks(ctx), UNLOCK_POLL_MS)
}

// ── Share card ─────────────────────────────────────────────────────────────

function themeVars(el) {
  const cs = getComputedStyle(el)
  const get = v => cs.getPropertyValue(v).trim() || null
  return {
    bg: get('--ui-bg-primary') || '#161616',
    surface: get('--ui-bg-tertiary') || '#232323',
    accent: get('--ui-accent') || '#7B2D8E',
    text: get('--ui-text-primary') || '#f2f2f2',
    secondary: get('--ui-text-secondary') || '#b0b0b0'
  }
}

function wrapText(ctx, text, maxWidth) {
  const words = String(text).split(/\s+/)
  const lines = []
  let line = ''
  for (const w of words) {
    const test = line ? line + ' ' + w : w
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line)
      line = w
    } else {
      line = test
    }
  }
  if (line) lines.push(line)
  return lines
}

function drawShareCard(canvas, item) {
  const W = 1200
  const H = 630
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  const t = themeVars(canvas)

  const grad = ctx.createLinearGradient(0, 0, W, H)
  grad.addColorStop(0, t.bg)
  grad.addColorStop(1, t.surface)
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, W, H)

  ctx.globalAlpha = 0.09
  ctx.fillStyle = t.accent
  ctx.beginPath()
  ctx.arc(200, 150, 280, 0, Math.PI * 2)
  ctx.fill()
  ctx.globalAlpha = 1

  ctx.fillStyle = t.secondary
  ctx.font = '600 26px -apple-system, system-ui, sans-serif'
  ctx.fillText('HERMES ACHIEVEMENT', 64, 78)

  ctx.fillStyle = t.accent
  ctx.beginPath()
  ctx.moveTo(64, 148)
  ctx.lineTo(96, 112)
  ctx.lineTo(128, 148)
  ctx.lineTo(96, 184)
  ctx.closePath()
  ctx.fill()

  ctx.fillStyle = t.text
  ctx.font = '700 72px -apple-system, system-ui, sans-serif'
  ctx.fillText(String(item.name || 'Achievement').slice(0, 28), 64, 268)

  const tierLabel = String(item.tier || 'EARNED').toUpperCase()
  ctx.font = '700 22px -apple-system, system-ui, sans-serif'
  const tw = ctx.measureText(tierLabel).width
  ctx.fillStyle = t.accent
  ctx.beginPath()
  if (ctx.roundRect) {
    ctx.roundRect(64, 300, tw + 36, 46, 23)
  } else {
    ctx.rect(64, 300, tw + 36, 46)
  }
  ctx.fill()
  ctx.fillStyle = '#ffffff'
  ctx.fillText(tierLabel, 64 + 18, 300 + 31)

  ctx.fillStyle = t.secondary
  ctx.font = '400 30px -apple-system, system-ui, sans-serif'
  const lines = wrapText(ctx, item.description || '', 1060).slice(0, 4)
  lines.forEach((l, i) => ctx.fillText(l, 64, 410 + i * 42))

  ctx.fillStyle = t.secondary
  ctx.font = '400 20px -apple-system, system-ui, sans-serif'
  ctx.fillText('Hermes · achievements · collected from real session history', 64, H - 48)
}

function ShareCardOverlay({ item, onClose }) {
  const canvasRef = useRef(null)

  useEffect(() => {
    if (canvasRef.current) drawShareCard(canvasRef.current, item)
  }, [item])

  useEffect(() => {
    const h = e => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  const download = () => {
    const c = canvasRef.current
    if (!c) return
    const url = c.toDataURL('image/png')
    const a = document.createElement('a')
    a.href = url
    a.download = `hermes-achievement-${item.id}.png`
    a.click()
  }

  return jsxs('div', {
    className: 'fixed inset-0 z-[1000] flex items-center justify-center bg-black/60 p-6',
    onClick: onClose,
    children: [
      jsxs('div', {
        className: 'flex flex-col gap-4 rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-primary) p-5 shadow-2xl',
        onClick: e => e.stopPropagation(),
        children: [
          jsx('canvas', {
            ref: canvasRef,
            className: 'w-[560px] max-w-full rounded-lg border border-(--ui-stroke-secondary)',
            style: { aspectRatio: '1200 / 630' }
          }),
          jsxs('div', {
            className: 'flex items-center justify-between gap-2',
            children: [
              jsx('span', {
                className: 'text-xs text-(--ui-text-tertiary)',
                children: `${item.name} · 1200×630 share card`
              }),
              jsxs('div', {
                className: 'flex items-center gap-2',
                children: [
                  jsx(Button, { variant: 'secondary', size: 'sm', onClick: onClose, children: 'Close' }),
                  jsx(Button, { variant: 'primary', size: 'sm', onClick: download, children: 'Download PNG' })
                ]
              })
            ]
          })
        ]
      })
    ]
  })
}

// ── Header / score strip ────────────────────────────────────────────────────

function ScoreHeader({ data, onRescan, rescinding }) {
  const { unlocked_count, discovered_count, secret_count, total_count } = data
  const pct = total_count ? Math.round((unlocked_count / total_count) * 100) : 0

  return jsxs('div', {
    className: 'border-b border-(--ui-stroke-secondary) px-6 py-5',
    children: [
      jsxs('div', {
        className: 'flex items-start justify-between gap-4',
        children: [
          jsxs('div', {
            children: [
              jsxs('div', {
                className: 'flex items-baseline gap-3',
                children: [
                  jsx('span', {
                    className: 'text-3xl font-semibold tabular-nums',
                    children: `${unlocked_count}/${total_count}`
                  }),
                  jsx('span', {
                    className: 'text-sm text-(--ui-text-secondary)',
                    children: `unlocked · ${pct}%`
                  })
                ]
              }),
              jsxs('div', {
                className: 'mt-1 flex items-center gap-3 text-xs text-(--ui-text-tertiary)',
                children: [
                  jsx('span', { children: `${discovered_count} discovered` }),
                  jsx('span', { children: `${secret_count} secret` }),
                  data.generated_at
                    ? jsx('span', {
                        children: `scanned ${relativeTime(data.generated_at * 1000)}`
                      })
                    : null,
                  data.is_stale
                    ? jsx(Badge, { variant: 'warn', children: 'stale' })
                    : null
                ]
              })
            ]
          }),
          jsx(Button, {
            variant: 'secondary',
            size: 'sm',
            disabled: rescinding,
            onClick: onRescan,
            children: rescinding ? 'Scanning…' : 'Rescan'
          })
        ]
      }),
      jsxs('div', {
        className: 'mt-4 h-1.5 w-full overflow-hidden rounded-full bg-(--ui-bg-quaternary)',
        children: [
          jsx('div', {
            className: cn('h-full rounded-full transition-all', 'bg-(--ui-accent)'),
            style: { width: `${Math.min(100, pct)}%` }
          })
        ]
      })
    ]
  })
}

// ── Next up strip ───────────────────────────────────────────────────────────

function NextUpStrip({ items }) {
  if (!items || items.length === 0) return null

  return jsxs('div', {
    className: 'border-b border-(--ui-stroke-secondary) px-6 py-4',
    children: [
      jsx('div', {
        className: 'mb-2 text-[0.6875rem] font-medium uppercase tracking-wide text-(--ui-text-tertiary)',
        children: 'Next up'
      }),
      jsxs('div', {
        className: 'grid grid-cols-1 gap-2 sm:grid-cols-3',
        children: items.map(a =>
          jsxs('div', {
            key: a.id,
            className: 'rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-secondary) p-3',
            children: [
              jsxs('div', {
                className: 'flex items-center justify-between gap-2',
                children: [
                  jsx('span', { className: 'truncate text-xs font-medium', children: a.name }),
                  jsx('span', {
                    className: 'shrink-0 text-[0.6875rem] tabular-nums text-(--ui-text-tertiary)',
                    children: `${a.progress_pct ?? 0}%`
                  })
                ]
              }),
              jsxs('div', {
                className: 'mt-2 h-1 w-full overflow-hidden rounded-full bg-(--ui-bg-quaternary)',
                children: [
                  jsx('div', {
                    className: 'h-full rounded-full bg-(--ui-accent)',
                    style: { width: `${Math.min(100, a.progress_pct ?? 0)}%` }
                  })
                ]
              }),
              a.next_tier
                ? jsx('div', {
                    className: 'mt-1.5 text-[0.6875rem] text-(--ui-text-quaternary)',
                    children: `next: ${a.next_tier} · ${a.next_threshold}`
                  })
                : null
            ]
          })
        )
      })
    ]
  })
}

// ── Session context ─────────────────────────────────────────────────────────

function SessionBadges() {
  const sessionId = useValue(host.state.activeSessionId)
  const { data, isLoading } = useQuery({
    queryKey: ['hermes-achievements', 'session', sessionId ?? 'none'],
    queryFn: () =>
      sessionId
        ? rest('/sessions/' + encodeURIComponent(sessionId) + '/badges', { timeoutMs: 8000 })
        : Promise.resolve({ badges: [] }),
    enabled: !!sessionId,
    refetchInterval: 60_000,
    staleTime: 30_000
  })

  if (!sessionId) return null

  const badges = data?.badges || []

  return jsxs('div', {
    className: 'border-b border-(--ui-stroke-secondary) px-6 py-3',
    children: [
      jsxs('div', {
        className: 'flex flex-wrap items-center gap-2 text-xs',
        children: [
          jsx('span', {
            className: 'text-(--ui-text-tertiary)',
            children: isLoading
              ? 'Checking this session…'
              : badges.length
                ? `Earned this session (${badges.length}):`
                : 'No badges this session yet.'
          }),
          ...badges.map(b =>
            jsx(Badge, {
              key: b.id,
              variant: 'outline',
              className: tierBadgeClass(b.tier),
              children: b.tier ? `${b.name} · ${b.tier}` : b.name
            })
          )
        ]
      })
    ]
  })
}

// ── Achievement card ────────────────────────────────────────────────────────

function AchievementCard({ item }) {
  const [open, setOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const isSecret = item.state === 'secret'
  const pct = item.progress_pct ?? 0

  return jsxs('div', {
    className: cn(
      'flex flex-col rounded-lg border p-4',
      item.unlocked
        ? 'border-(--ui-stroke-strong) bg-(--ui-bg-tertiary)'
        : 'border-(--ui-stroke-secondary) bg-(--ui-bg-secondary)',
      isSecret && 'opacity-70'
    ),
    children: [
      jsxs('div', {
        className: 'flex items-start justify-between gap-2',
        children: [
          jsxs('div', {
            className: 'flex min-w-0 items-center gap-2',
            children: [
              jsx(Codicon, {
                name: 'milestone',
                className: cn('shrink-0', item.unlocked ? 'text-(--ui-accent)' : 'text-(--ui-text-tertiary)')
              }),
              jsx('span', {
                className: 'truncate text-sm font-medium',
                children: isSecret ? '???' : item.name
              })
            ]
          }),
          jsxs('div', {
            className: 'flex shrink-0 items-center gap-1.5',
            children: [
              item.tier
                ? jsx(Badge, {
                    variant: 'outline',
                    className: cn('shrink-0 text-[0.6875rem]', tierBadgeClass(item.tier)),
                    children: item.tier
                  })
                : item.unlocked
                  ? jsx(Badge, {
                      variant: 'outline',
                      className: 'shrink-0 text-[0.6875rem] text-(--ui-accent)',
                      children: 'Earned'
                    })
                  : null,
              item.unlocked && !isSecret
                ? jsx('button', {
                    type: 'button',
                    onClick: () => setShareOpen(true),
                    className:
                      'inline-flex items-center gap-1 rounded-md border border-(--ui-stroke-secondary) px-1.5 py-0.5 text-[0.6875rem] text-(--ui-text-tertiary) transition-colors hover:text-(--ui-text-primary)',
                    children: jsxs('span', {
                      className: 'inline-flex items-center gap-1',
                      children: [jsx(Codicon, { name: 'share', size: '0.75rem' }), 'Share']
                    })
                  })
                : null
            ]
          })
        ]
      }),
      jsx('p', {
        className: 'mt-2 line-clamp-2 text-xs leading-relaxed text-(--ui-text-tertiary)',
        children: isSecret ? 'Secret achievement — hidden until the first matching signal appears.' : item.description
      }),
      jsxs('div', {
        className: 'mt-3',
        children: [
          jsxs('div', {
            className: 'flex items-center justify-between text-[0.6875rem] text-(--ui-text-tertiary)',
            children: [
              jsx('span', {
                children: item.unlocked ? (item.next_tier ? `next: ${item.next_tier} · ${item.next_threshold}` : 'max tier') : (item.next_tier ? `next: ${item.next_tier} · ${item.next_threshold}` : '')
              }),
              jsx('span', { className: 'tabular-nums', children: isSecret ? '' : `${pct}%` })
            ]
          }),
          jsxs('div', {
            className: 'mt-1 h-1 w-full overflow-hidden rounded-full bg-(--ui-bg-quaternary)',
            children: [
              jsx('div', {
                className: cn('h-full rounded-full', progressBarClass(item.state)),
                style: { width: `${isSecret ? 0 : Math.min(100, pct)}%` }
              })
            ]
          })
        ]
      }),
      item.criteria
        ? jsxs('div', {
            className: 'mt-3',
            children: [
              jsx('button', {
                className: 'text-[0.6875rem] text-(--ui-text-tertiary) underline decoration-dotted underline-offset-2 hover:text-(--ui-text-primary)',
                type: 'button',
                onClick: () => setOpen(o => !o),
                children: open ? 'Hide what counts' : 'What counts?'
              }),
              open
                ? jsx('p', {
                    className: 'mt-1.5 text-[0.6875rem] leading-relaxed text-(--ui-text-tertiary)',
                    children: item.criteria
                  })
                : null
            ]
          })
        : null,
      item.evidence && item.evidence.title
        ? jsx('p', {
            className: 'mt-2 truncate text-[0.6875rem] text-(--ui-text-quaternary)',
            children: 'evidence: ' + item.evidence.title
          })
        : null,
      shareOpen
        ? jsx(ShareCardOverlay, { item, onClose: () => setShareOpen(false) })
        : null
    ]
  })
}

// ── Page ────────────────────────────────────────────────────────────────────

function AchievementsPage() {
  const [filter, setFilter] = useState('all')
  const [rescinding, setRescinding] = useState(false)

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['hermes-achievements', 'all'],
    queryFn: () => rest('/achievements'),
    refetchInterval: 120_000
  })

  const rescan = async () => {
    setRescinding(true)
    try {
      await rest('/rescan', { method: 'POST' })
      await queryClient.invalidateQueries({ queryKey: ['hermes-achievements'] })
    } catch (e) {
      host.notify({ kind: 'error', message: `Achievements rescan failed: ${e?.message ?? e}` })
    } finally {
      setRescinding(false)
    }
  }

  if (isLoading) {
    return jsx('div', {
      className: 'grid h-full grid-cols-1 gap-4 overflow-y-auto p-6 sm:grid-cols-2 lg:grid-cols-3',
      children: Array.from({ length: 9 }, () =>
        jsx(Skeleton, { className: 'h-40 w-full rounded-lg' })
      )
    })
  }

  if (isError || !data) {
    return jsx(ErrorState, {
      title: 'Could not load achievements',
      description: `${error?.message ?? 'Unknown error'} — is the achievements plugin enabled?`,
      children: jsx(Button, { variant: 'secondary', onClick: () => refetch(), children: 'Retry' })
    })
  }

  const items = data.achievements || []
  const shown = items.filter(a => filter === 'all' || a.state === filter)
  const nextUp = items
    .filter(a => !a.unlocked && a.state !== 'secret' && (a.progress_pct ?? 0) > 0)
    .sort((x, y) => (y.progress_pct ?? 0) - (x.progress_pct ?? 0))
    .slice(0, 3)

  return jsxs('div', {
    className: 'flex h-full min-h-0 flex-col',
    children: [
      jsx(ScoreHeader, { data, onRescan: rescan, rescinding }),
      jsx(SessionBadges, {}),
      jsx(NextUpStrip, { items: nextUp }),
      jsxs('div', {
        className: 'flex items-center gap-1 border-b border-(--ui-stroke-secondary) px-6 py-2',
        children: FILTERS.map(f => {
          const count =
            f === 'all'
              ? data.total_count
              : f === 'unlocked'
                ? data.unlocked_count
                : f === 'discovered'
                  ? data.discovered_count
                  : data.secret_count
          return jsx('button', {
            key: f,
            className: cn(
              'rounded-md px-2.5 py-1 text-xs capitalize transition-colors',
              filter === f
                ? 'bg-(--ui-bg-quaternary) text-(--ui-text-primary)'
                : 'text-(--ui-text-tertiary) hover:text-(--ui-text-primary)'
            ),
            type: 'button',
            onClick: () => setFilter(f),
            children: `${f} (${count})`
          })
        })
      }),
      shown.length === 0
        ? jsx(EmptyState, {
            title: 'No achievements here',
            description: 'Nothing in this state yet — keep using Hermes.'
          })
        : jsx('div', {
            className: 'grid flex-1 auto-rows-min grid-cols-1 gap-4 overflow-y-auto p-6 sm:grid-cols-2 lg:grid-cols-3',
            children: shown.map(a => jsx(AchievementCard, { key: a.id, item: a }))
          })
    ]
  })
}

// ── Statusbar score chip ────────────────────────────────────────────────────

function ScoreChip() {
  const { data } = useQuery({
    queryKey: ['hermes-achievements', 'chip'],
    queryFn: () => rest('/achievements'),
    refetchInterval: 120_000
  })

  if (!data || !data.unlocked_count) return null

  return jsx(Tip, {
    label: `Achievements: ${data.unlocked_count}/${data.total_count} unlocked`,
    children: jsx('button', {
      className: cn(
        'inline-flex h-full items-center gap-1 rounded-none px-1.5 text-[0.6875rem] tabular-nums transition-colors',
        'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
      ),
      type: 'button',
      onClick: () => {
        haptic('tap')
        host.navigate('/achievements')
      },
      children: jsxs('span', {
        className: 'inline-flex items-center gap-1',
        children: [
          jsx(Codicon, { name: 'milestone', size: '0.7rem' }),
          jsx('span', { children: `${data.unlocked_count}/${data.total_count}` })
        ]
      })
    })
  })
}

// ── Plugin export ───────────────────────────────────────────────────────────

export default {
  id: ID,
  name: 'Achievements',
  description:
    'Hermes achievement badges — collectible tiers from real session history. Read-only dashboard backed by the hermes-achievements plugin API, with unlock notifications, confetti celebrations, next-up tracking, per-session context, and share cards.',
  defaultEnabled: true,
  register(ctx) {
    rest = ctx.rest
    startUnlockWatcher(ctx)

    ctx.registerMany([
      {
        id: 'page',
        area: ROUTES_AREA,
        data: { path: '/achievements' },
        title: 'Achievements',
        render: () => jsx(AchievementsPage, {})
      },
      {
        id: 'nav',
        area: SIDEBAR_NAV_AREA,
        order: 55,
        data: { path: '/achievements', label: 'Achievements', codicon: 'milestone' }
      },
      {
        id: 'score',
        area: STATUSBAR_AREAS.right,
        order: 90,
        render: () => jsx(ScoreChip, {})
      },
      {
        id: 'open',
        area: PALETTE_AREA,
        data: {
          id: 'hermes-achievements.open',
          label: 'Achievements: Open',
          keywords: ['achievements', 'badges', 'tiers', 'trophy'],
          run: () => {
            haptic('tap')
            host.navigate('/achievements')
          }
        }
      }
    ])
  }
}
