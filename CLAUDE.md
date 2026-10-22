# amble: flowtime+

A minimalist flow-time technique timer built with Tauri v2 and Tailwind CSS.
Cross-platform (Windows, macOS, Linux).

## Philosophy

Rest is not the opposite of work — rest is part of work.

flowtime+ dropped the idea of a "total session length" entirely. The only thing
the app models is one loop: work → rest, at a ratio you pick before you start.
Work time itself is never displayed.

The readout is a **two-account ledger**, not a single hero number:

```
  EARNED  │  UNUSED
   00:30  │   03:20
```

`EARNED` is what this cycle has bought so far (`workElapsed × ratio`); `UNUSED`
is the banked pool. **Whichever account is in play is solid; the dormant one
fades back.** That one rule explains the whole state machine visually, and it
makes the two-phase rest handoff legible: the left column counts down to
`00:00` and fades, the right column turns amber and takes over.

Rest you do not use is not lost: it lands in an unused-rest pool, which is
spent automatically once the earned rest runs out and resets every local
midnight.

## Tech Stack

| Layer | Choice | Notes |
|-------|--------|-------|
| Desktop shell | Tauri v2 | Native windows, ~3-5 MB bundle |
| Frontend tooling | Vite 6 + TypeScript 5.7 | HMR, strict type checking |
| CSS | Tailwind CSS v3 via CLI + PostCSS | Fully offline build, Inter font bundled locally |
| State | Plain class (FlowTimer) | Zero deps, observer pattern |
| Backend (Rust) | Minimal scaffold | Timer logic is pure frontend; Rust reserved for future |

## Project Structure

```
amble-flowtime/
├── CLAUDE.md                  # This file
├── index.html                 # Vite entry + app shell
├── mini.html                  # Mini overlay window
├── package.json               # Node deps
├── tsconfig.json              # Strict TS config (only covers src/)
├── vite.config.ts             # Vite + multi-page build
├── tailwind.config.js         # Tailwind theme (accent, Inter font)
├── postcss.config.js          # PostCSS with Tailwind + Autoprefixer
├── src/
│   ├── main.ts                # Bootstrap: create timer, wire UI & storage
│   ├── timer.ts               # FlowTimer class (state machine + timing + pool settle)
│   ├── pool.ts                # Unused-rest pool (localStorage, daily reset)
│   ├── ui.ts                  # DOM manipulation, render(), setupUI()
│   ├── types.ts               # Shared TypeScript types
│   ├── storage.ts             # SQLite session persistence
│   ├── overlay.ts             # Mini overlay window script
│   └── style.css              # Tailwind directives + custom CSS
├── scripts/
│   └── timer-selftest.ts      # Headless timer/pool semantics test (npm run selftest)
├── src-tauri/
│   ├── Cargo.toml             # tauri 2, serde, serde_json, tauri-plugin-sql
│   ├── build.rs               # tauri-build
│   ├── tauri.conf.json        # Window 400×580, borderless, resizable
│   ├── capabilities/
│   │   └── default.json       # App permissions
│   ├── icons/                 # App icons
│   └── src/
│       ├── lib.rs             # Tauri builder with plugins
│       ├── main.rs            # Desktop entry point
│       └── backup.rs          # Database backup command (flowtime-plus.db)
└── todo.md                    # Project roadmap
```

## Architecture: Timer State Machine

```
idle ──[start]──> running ──[pause]──> paused ──[startRest]──> resting ──[auto/done]──> idle
                     │                    │
                     └──[stop]──> idle    └──[stop]──> idle
                                          └──[resume]──> running
```

**States:**
- **idle**: Timer reset, ratio editable; only the pool is solid
- **running**: Work counting up, `EARNED` rising, `UNUSED` held at mid tone
- **paused**: Work stopped, earned rest settled; **both** accounts go solid
- **resting**: `EARNED` counts down in green, then fades and `UNUSED` takes over
  in amber, then auto-stop

**Key behaviors:**
- `start()`: Works from idle or paused state
- `pause()`: Settles `restTarget = workElapsed × ratio`, enters paused
- `resume()`: Continues work from paused (accumulated time preserved)
- `startRest()`: Snapshots the pool into `poolAtRestStart` and counts down
  the earned rest, then the pool. No-op when earned + pool is 0.
- `stop()`: Banks leftover rest into the pool, emits the session, resets to idle
- `setRatio()`: Returns `false` (change ignored) unless the state is `idle`
- Auto-stop: When `earned + poolAtRestStart` is exhausted, transitions to idle

**Unused-rest settlement** (`settleRestPool`), where `P` is the pool snapshot
taken at rest start and `D` the rest actually taken:

```
spentEarned = min(D, restTarget)
spentPool   = min(max(0, D − restTarget), P)
pool        = P − spentPool + (restTarget − spentEarned)
```

So ending a rest early banks the remainder, running past the earned rest spends
the pool instead, and the two phases never mix. Because the budget is a snapshot
taken before the rest begins, a rest can never run longer than
`earned + pool-at-start` — that is what rules out infinite rest.

## Architecture Decisions

### Timer in Frontend (TypeScript)
The timer uses `Date.now()` diff-based timing in the browser.
No Rust backend involvement — avoids IPC overhead every 250ms tick.
OS-level features (notifications, sleep prevention, system tray) are future concerns.

### Drift Prevention
Uses absolute `Date.now()` timestamps rather than incrementing a counter.
Each tick recalculates elapsed from `segmentStartTime`. If the interval is
throttled (minimized window, etc.), it catches up on the next tick.

### Tick Interval: 250ms
Provides smooth second-boundary transitions without measurable CPU cost.

### Ratio
- Stored as a decimal (0.05–1.0)
- Default: 0.20 (work 5:1 = 20% rest)
- Displayed as percentage + ratio string (e.g., "20% ≈ (work 5:1)")
- **Locked while a cycle is running** — both sliders are disabled and the
  settings panel shows "Only settable before a cycle starts"
- Persisted in `localStorage` under `amble-default-ratio`

### Unused-rest pool
- Lives in `src/pool.ts`, `localStorage` key `flowtime-plus-unused-rest`
- Stored as `{ date: "YYYY-MM-DD", ms }`; any other date is discarded on read,
  so it resets at local midnight (the key uses **local** time, not UTC)
- `main.ts` also polls the date once a minute so a running app rolls over too
- Persisted on every session end via the `unusedRestMs` field of `SessionEndData`
- `unused` column turns amber only while the pool is actually being spent
- Not part of the SQLite schema — it is single-day state, not history

### Statistics panel
The panel behind the bar-chart icon shows **four plain numbers** for the
selected window: 总专注 / 会话数 / 平均每次 / 休息占比. There is deliberately
**no chart** — the original bar chart was removed along with the economy
experiment, and the next design has not been decided yet.

- `renderStats()` in `ui.ts` calls `getStatsBetween(since, until)` in
  `storage.ts`, a single `GROUP BY block_type` aggregate over `time_blocks`.
- `getDateRange()` builds Monday-based weeks, calendar months and calendar
  years; `statsOffset` walks backwards, and `stat-next` is hidden at the
  current period so the UI cannot page into the future.
- Empty windows render `—` rather than `0`, so "no data yet" never reads as a
  real measurement.
- `time_blocks` is written by `saveSession` and read only here.

### Ledger emphasis
`render()` in `ui.ts` resolves one tone per column. Three neutral levels plus
two semantic tones; numbers carry the emphasis, labels stay at `neutral-400`
except when the column is semantic.

| Tone | Number | When |
|------|--------|------|
| `ghost` | `neutral-300` | account is empty or inactive |
| `mid` | `neutral-500` | pool held while a cycle is in flight |
| `solid` | `neutral-800` | account in play (or both, when paused) |
| `rest` | `emerald-500` | earned rest counting down |
| `pool` | `amber-500` | pool counting down |

- All ledger spans carry `transition-colors duration-200`, so the idle→start
  handoff and every phase change is a fade, never a snap
- Banked leftovers trigger a one-second `amber-400` flash on the `unused` column
  (`flashColumn`), which is the only reward feedback in the app
- Colon pulse: `timer-running` is toggled on whichever column container is live;
  `src/style.css` animates `.timer-running .timer-colon`
- **Size ceiling**: `text-5xl` is the max at the 320px (`max-w-xs`) column width.
  `text-6xl` needs ~339px and would overflow.

### Timer panel layout
Vertical order inside `#panel-timer`: state caption → ledger → controls →
ratio. The ratio is a **pre-start setting** (locked for the whole cycle), so it
lives at the foot as a deliberately quieter footer instead of sitting between
the readout and the play button. Keeping something below the controls is what
stops the play button from reading as the "foot" of the column — the original
long-strip composition relied on the timeline and quick-add filling that space,
and they are gone.

All three panels are children of `#panels` (`flex-1`) and each carries
`my-auto`, so the visible one is vertically centred in the leftover height.
`my-auto` rather than `justify-center` is deliberate: auto margins collapse to
zero once a panel is taller than the viewport, so the tall stats panel scrolls
instead of having its top clipped.

The window is 580px tall with `pt-10 pb-8`, leaving ~508px of usable height;
the timer panel needs ~294px of it. If you remove content, re-check that the
auto-centring still leaves sensible breathing room instead of dead space.

### Primary action
The action is a **single capsule row**, not a set of ad-hoc buttons. Every
button in `#controls > div` is `flex-1 h-12`, and hidden ones are `display:none`,
so whichever are visible simply share the row: one capsule when the state has a
single action, two half-width capsules when it does not. The footprint is the
same in every state, so the centred panel never jumps.

| State | Capsules | Secondary |
|-------|----------|-----------|
| `idle` | `▶ Start` (accent) | — |
| `running` | `⏸ Pause` (neutral) | End Session link |
| `paused` | `▶ Resume` (neutral) + `☾ Start Rest` (accent) | End Session link |
| `resting` | `■ End Rest` (neutral) | — |

Capsules are `rounded-xl` (12px), not `rounded-full` — the pill shape read as
too soft against the app's `rounded-xl` card language.

- **No duplicate start affordance.** The old top-right mini play button was
  removed on purpose; do not reintroduce a second way to call `start()`.
- The `End Session` link uses `invisible`, not `hidden`: it keeps its space so
  the centred panel does not shift when the link appears.
- Both `End Rest` and the `End Session` link call `timer.stop()`. During rest
  that is the only exit, and it banks the leftover into the pool.

### Ratio slider
The ratio control is the only widget with real ergonomics to preserve.

- `input[type="range"]` is a **28px-tall hit area** and the visible 8px track is
  painted on `::-webkit-slider-runnable-track`, not on the input. The original
  made the input itself 6px tall, so you had to hit a 6px strip to grab it.
- Thumb is **22px**. Half of that is hardcoded in three places that must move
  together: the tick-label row's `mx-[11px]`, `THUMB_PX` in `ui.ts`, and the
  thumb size in `style.css`.
- Tick labels sit at their **true** fraction of the 5–100 range
  (5/25/50/75/100 → 0/21.05/47.37/73.68/100%). The original used
  `justify-between`, which put "50%" at the midpoint — on a 5–100 range the
  midpoint is 52.5%, so the label was lying by 2.5 points.
- Every mutation path (drag, click, wheel, arrow keys) funnels through a single
  `input` listener. Wheel and arrow keys both move exactly 1%.
- `#ratio-bubble` shows the exact percentage above the thumb, positioned with
  `calc(11px + f * (100% - 22px))`, faded out 1.2s after the last change.

## Development Commands

```bash
# Install dependencies
npm install

# Run in dev mode (with hot reload)
npm run tauri dev

# TypeScript type check
npx tsc --noEmit

# Build for production
npm run tauri build

# Timer/pool semantics self-test (headless, no DOM, deterministic clock)
npm run selftest
```

`npm run selftest` bundles `scripts/timer-selftest.ts` with the esbuild that
ships with Vite and runs it under plain node. It covers the readout number per
state, ratio locking, pause settlement, pool accrual/spending, the rest budget
cap, and the daily reset. Run it after touching `timer.ts` or `pool.ts`.

The statistics panel has no headless coverage — it is one SQL aggregate behind
a date-range helper.

### Prerequisites (Windows)
- Node.js >= 18
- Rust >= 1.77
- Microsoft Visual C++ Build Tools
- WebView2 runtime (pre-installed on Windows 11)

## Known Limitations

| Limitation | Mitigation |
|------------|------------|
| Timer format MM:SS only | Sufficient for < 99 min; at `text-5xl` three-digit minutes exceed the 320px column |
| Pool lost if the app dies mid-rest | It only banks on session end; acceptable for a daily allowance |
| Pool is localStorage, not SQLite | Single-day state; not worth a table or a migration |
| Statistics page has no chart | Deliberate placeholder — four plain numbers until the next design |
| No notifications on rest complete | Add tauri-plugin-notification later |
| No system tray / background mode | Tauri plugin in future step |
| No sound alerts | Future enhancement |
| Fonts bundled (165 KB) | Acceptable; only Latin subset loaded |

## Future Roadmap (from todo.md)

Note: the original roadmap's items 1 and 2 were **built and then deliberately
removed** in flowtime+ — there is no time block view and no quick-add. They may
come back in a different form; the DB schema still has `is_manual`/`tag`/`note`
columns to support that.

1. **Forgiveness** (零挫败感):
   - Rest overtime goes negative silently (no punishment)
   - Slider to quickly record actual duration for long sessions
   - Note: the old "stats at week/month granularity" item is gone — the panel
     was replaced by the numeric stats placeholder.
2. **Production polish**:
   - ~~Replace Tailwind CDN with CLI/PostCSS build~~ ✅
   - Add app icons
   - System tray integration
   - Notifications on state transitions
   - Prevent system sleep during active sessions
