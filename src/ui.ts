import type { FlowTimer } from "./timer";
import type { TimerSnapshot } from "./types";
import { formatDuration, getStatsBetween } from "./storage";

// --- DOM references (set once on init) ---
let elStateLabel: HTMLElement;
let earnedCol: Column;
let unusedCol: Column;
let elRatioDisplay: HTMLElement;
let elRatioSlider: HTMLInputElement;
let elRatioBubble: HTMLElement;
let elRatioLock: HTMLElement;
let elBtnStart: HTMLElement;
let elBtnPause: HTMLElement;
let elBtnResume: HTMLElement;
let elBtnRest: HTMLElement;
let elBtnEndRest: HTMLElement;
let elBtnStop: HTMLElement;

// --- Helpers ---

function formatMinutes(ms: number): { minutes: string; seconds: string } {
  const totalSeconds = Math.floor(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return {
    minutes: String(m).padStart(2, "0"),
    seconds: String(s).padStart(2, "0"),
  };
}

function formatRatio(ratio: number): string {
  const pct = Math.round(ratio * 100);
  const workParts = Math.round(1 / ratio);
  return `${pct}% ≈ (work ${workParts}:1)`;
}

function setVisible(el: HTMLElement, visible: boolean): void {
  el.classList.toggle("hidden", !visible);
}

// --- Ratio slider -----------------------------------------------------------
// A continuous 5–100% control. `THUMB_PX` must match ::-webkit-slider-thumb in
// style.css; index.html insets its tick labels by the same half-width so the
// labels sit on the values they claim.

const RATIO_MIN = 5;
const RATIO_MAX = 100;
const THUMB_PX = 22;

let bubbleHideTimer: number | null = null;

/** Show the exact percentage right above the thumb. */
function placeRatioBubble(value: number): void {
  if (!elRatioBubble) return;
  const fraction = (value - RATIO_MIN) / (RATIO_MAX - RATIO_MIN);
  elRatioBubble.textContent = `${value}%`;
  elRatioBubble.style.left = `calc(${THUMB_PX / 2}px + ${fraction} * (100% - ${THUMB_PX}px))`;
  elRatioBubble.classList.remove("opacity-0");
  if (bubbleHideTimer !== null) {
    window.clearTimeout(bubbleHideTimer);
    bubbleHideTimer = null;
  }
}

function hideRatioBubble(delay = 0): void {
  if (!elRatioBubble) return;
  if (bubbleHideTimer !== null) window.clearTimeout(bubbleHideTimer);
  bubbleHideTimer = window.setTimeout(() => {
    elRatioBubble.classList.add("opacity-0");
    bubbleHideTimer = null;
  }, delay);
}

// --- Ledger columns ---------------------------------------------------------
// The readout is two accounts side by side. `earned` is what this cycle has
// bought so far; `unused` is the banked pool. Each column has one emphasis
// tone, and the column currently in play is the solid one.

type Tone = "ghost" | "mid" | "solid" | "rest" | "pool";

interface Column {
  minutes: HTMLElement;
  seconds: HTMLElement;
  colon: HTMLElement;
  label: HTMLElement;
  container: HTMLElement;
  flashing: boolean;
}

// Numbers carry the emphasis; labels stay calm and only echo the two semantic
// tones (rest = green, pool = amber) so the type baseline never shifts.
const NUM_TONE: Record<Tone, string> = {
  ghost: "text-neutral-300",
  mid: "text-neutral-500",
  solid: "text-neutral-800",
  rest: "text-emerald-500",
  pool: "text-amber-500",
};

const LABEL_TONE: Record<Tone, string> = {
  ghost: "text-neutral-400",
  mid: "text-neutral-400",
  solid: "text-neutral-400",
  rest: "text-emerald-500",
  pool: "text-amber-500",
};

const NUM_CLASSES = [
  "text-neutral-300",
  "text-neutral-500",
  "text-neutral-800",
  "text-emerald-500",
  "text-amber-400",
  "text-amber-500",
];

const LABEL_CLASSES = [
  "text-neutral-400",
  "text-emerald-500",
  "text-amber-400",
  "text-amber-500",
];

function setNumber(col: Column, ms: number): void {
  const { minutes, seconds } = formatMinutes(ms);
  col.minutes.textContent = minutes;
  col.seconds.textContent = seconds;
}

function setTone(col: Column, tone: Tone): void {
  if (col.flashing) return;
  for (const el of [col.minutes, col.seconds, col.colon]) {
    el.classList.remove(...NUM_CLASSES);
    el.classList.add(NUM_TONE[tone]);
  }
  col.label.classList.remove(...LABEL_CLASSES);
  col.label.classList.add(LABEL_TONE[tone]);
}

/** Brief highlight for the moment a rest ends early and leftover lands in the pool. */
function flashColumn(col: Column): void {
  col.flashing = true;
  for (const el of [col.minutes, col.seconds, col.colon]) {
    el.classList.remove(...NUM_CLASSES);
    el.classList.add("text-amber-400");
  }
  window.setTimeout(() => {
    col.flashing = false;
  }, 800);
}

// --- Render ---

let prevPoolMs: number | null = null;

export function render(snap: TimerSnapshot): void {
  const resting = snap.state === "resting";
  // Second half of a rest: the earned rest is gone, the pool is being spent.
  const spendingPool = resting && snap.restPhase === "unused";

  // Caption sits above the ledger. The column labels carry everything else, so
  // this only needs to say "you are resting right now".
  const caption = resting ? "resting" : "";
  elStateLabel.textContent = caption || "\u00a0";
  elStateLabel.classList.toggle("invisible", caption === "");
  elStateLabel.classList.toggle("text-emerald-500", resting && !spendingPool);
  elStateLabel.classList.toggle("text-amber-500", spendingPool);

  // --- EARNED: what this cycle has bought ---
  let earnedMs = 0;
  let earnedTone: Tone = "ghost";
  if (snap.state === "running") {
    earnedMs = snap.restEarnedMs;
    earnedTone = "solid";
  } else if (snap.state === "paused") {
    earnedMs = snap.restTargetMs;
    earnedTone = "solid";
  } else if (resting) {
    if (spendingPool) {
      earnedMs = 0;
      earnedTone = "ghost";
    } else {
      earnedMs = snap.restRemainingMs;
      earnedTone = "rest";
    }
  }

  // --- UNUSED: the banked pool ---
  let unusedMs: number;
  let unusedTone: Tone;
  if (spendingPool) {
    unusedMs = snap.restRemainingMs;
    unusedTone = "pool";
  } else {
    unusedMs = snap.unusedRestMs;
    if (snap.state === "idle" || snap.state === "paused") {
      // Nothing else is happening: the balance is the whole story.
      unusedTone = unusedMs > 0 ? "solid" : "ghost";
    } else {
      // A cycle is in flight — the pool is held, not in play.
      unusedTone = unusedMs > 0 ? "mid" : "ghost";
    }
  }

  setNumber(earnedCol, earnedMs);
  setNumber(unusedCol, unusedMs);

  if (prevPoolMs !== null && snap.unusedRestMs > prevPoolMs) {
    flashColumn(unusedCol);
  }
  prevPoolMs = snap.unusedRestMs;

  setTone(earnedCol, earnedTone);
  setTone(unusedCol, unusedTone);

  // Colon pulse on whichever account is actually moving.
  earnedCol.container.classList.toggle(
    "timer-running",
    snap.state === "running" || (resting && !spendingPool),
  );
  unusedCol.container.classList.toggle("timer-running", spendingPool);

  // Ratio display + slider
  elRatioDisplay.textContent = formatRatio(snap.ratio);
  const sliderVal = String(Math.round(snap.ratio * 100));
  if (elRatioSlider.value !== sliderVal) {
    elRatioSlider.value = sliderVal;
  }

  // Ratio is frozen once a cycle has begun.
  const locked = snap.state !== "idle";
  elRatioSlider.disabled = locked;
  elRatioSlider.classList.toggle("opacity-40", locked);
  elRatioSlider.classList.toggle("cursor-not-allowed", locked);
  elRatioLock.classList.toggle("hidden", !locked);

  // Button visibility — one capsule row, so the footprint is identical in
  // every state and the panel never jumps.
  setVisible(elBtnStart, snap.state === "idle");
  setVisible(elBtnPause, snap.state === "running");
  setVisible(elBtnResume, snap.state === "paused");
  setVisible(elBtnRest, snap.state === "paused");
  setVisible(elBtnEndRest, snap.state === "resting");

  // The secondary escape hatch keeps its space (invisible, not hidden) so the
  // centred panel does not shift when it appears.
  elBtnStop.classList.toggle(
    "invisible",
    !(snap.state === "running" || snap.state === "paused"),
  );
}

// --- Setup ---

function readColumn(prefix: "earned" | "unused"): Column {
  return {
    minutes: document.getElementById(`${prefix}-minutes`)!,
    seconds: document.getElementById(`${prefix}-seconds`)!,
    colon: document.getElementById(`${prefix}-colon`)!,
    label: document.getElementById(`${prefix}-label`)!,
    container: document.getElementById(`${prefix}-container`)!,
    flashing: false,
  };
}

export function setupUI(timer: FlowTimer): void {
  // Cache DOM references
  elStateLabel = document.getElementById("state-label")!;
  earnedCol = readColumn("earned");
  unusedCol = readColumn("unused");
  elRatioDisplay = document.getElementById("ratio-display")!;
  elRatioSlider = document.getElementById("ratio-slider") as HTMLInputElement;
  elRatioBubble = document.getElementById("ratio-bubble")!;
  elRatioLock = document.getElementById("ratio-lock")!;
  elBtnStart = document.getElementById("btn-start")!;
  elBtnPause = document.getElementById("btn-pause")!;
  elBtnResume = document.getElementById("btn-resume")!;
  elBtnRest = document.getElementById("btn-rest")!;
  elBtnEndRest = document.getElementById("btn-end-rest")!;
  elBtnStop = document.getElementById("btn-stop")!;

  // Wire timer controls
  elBtnStart.addEventListener("click", () => timer.start());
  elBtnPause.addEventListener("click", () => timer.pause());
  elBtnResume.addEventListener("click", () => timer.resume());
  elBtnRest.addEventListener("click", () => timer.startRest());
  elBtnEndRest.addEventListener("click", () => timer.stop());
  elBtnStop.addEventListener("click", () => timer.stop());

  // Ratio slider — mirrors the settings slider, both only usable while idle
  const elSettingRatioSlider = document.getElementById(
    "setting-ratio-slider",
  ) as HTMLInputElement;
  const elSettingRatioDisplay = document.getElementById("setting-ratio-display")!;
  const elSettingRatioHint = document.getElementById("setting-ratio-hint")!;

  // One handler owns every way the ratio can change: drag, click, wheel and the
  // arrow keys (which the range input handles natively). Anything that mutates
  // the slider value dispatches a bubbling `input`.
  elRatioSlider.addEventListener("input", () => {
    const value = parseInt(elRatioSlider.value);
    placeRatioBubble(value);
    hideRatioBubble(1200);

    const r = value / 100;
    if (!timer.setRatio(r)) return;
    elSettingRatioSlider.value = String(value);
    elSettingRatioDisplay.textContent = formatRatio(r);
    localStorage.setItem("amble-default-ratio", String(r));
  });

  // Wheel nudges by a single percent, so every value is reachable without the
  // precision problem of a 300px track with 96 steps in it.
  elRatioSlider.addEventListener(
    "wheel",
    (e) => {
      if (timer.getSnapshot().state !== "idle") return;
      e.preventDefault();
      const next = Math.min(
        RATIO_MAX,
        Math.max(RATIO_MIN, parseInt(elRatioSlider.value) + (e.deltaY < 0 ? 1 : -1)),
      );
      if (String(next) === elRatioSlider.value) return;
      elRatioSlider.value = String(next);
      elRatioSlider.dispatchEvent(new Event("input", { bubbles: true }));
    },
    { passive: false },
  );

  elRatioSlider.addEventListener("pointerdown", () => {
    placeRatioBubble(parseInt(elRatioSlider.value));
  });
  const releaseRatio = () => hideRatioBubble(400);
  elRatioSlider.addEventListener("pointerup", releaseRatio);
  elRatioSlider.addEventListener("pointercancel", releaseRatio);
  elRatioSlider.addEventListener("blur", () => hideRatioBubble(0));

  elSettingRatioSlider?.addEventListener("input", () => {
    const r = parseInt(elSettingRatioSlider.value) / 100;
    if (!timer.setRatio(r)) return;
    elSettingRatioDisplay.textContent = formatRatio(r);
    elRatioSlider.value = elSettingRatioSlider.value;
    localStorage.setItem("amble-default-ratio", String(r));
  });

  // Sync both sliders to the timer's current ratio (restored from localStorage).
  const initRatio = timer.getSnapshot().ratio;
  const initVal = String(Math.round(initRatio * 100));
  elRatioSlider.value = initVal;
  elSettingRatioSlider.value = initVal;
  elSettingRatioDisplay.textContent = formatRatio(initRatio);

  // Keep the settings slider locked in step with the main one.
  const syncSettingsLock = (locked: boolean) => {
    elSettingRatioSlider.disabled = locked;
    elSettingRatioSlider.classList.toggle("opacity-40", locked);
    elSettingRatioSlider.classList.toggle("cursor-not-allowed", locked);
    elSettingRatioHint.classList.toggle("hidden", !locked);
  };
  syncSettingsLock(timer.getSnapshot().state !== "idle");
  timer.onTick((snap) => syncSettingsLock(snap.state !== "idle"));

  // Segmented control: switch between timer / stats / settings views
  type ViewKind = "timer" | "stats" | "settings";
  const elPanelTimer = document.getElementById("panel-timer")!;
  const elPanelStats = document.getElementById("panel-stats")!;
  const elPanelSettings = document.getElementById("panel-settings")!;
  const elSegTimer = document.getElementById("seg-timer")!;
  const elSegStats = document.getElementById("seg-stats")!;
  const elSegSettings = document.getElementById("seg-settings")!;
  const elSegSlider = document.getElementById("seg-slider")!;
  const SLIDER_BASE = "absolute left-0.5 top-0.5 w-7 h-7 bg-white rounded-lg shadow-sm";

  function switchTo(view: ViewKind) {
    elPanelTimer.classList.toggle("hidden", view !== "timer");
    elPanelStats.classList.toggle("hidden", view !== "stats");
    elPanelSettings.classList.toggle("hidden", view !== "settings");

    const setSeg = (el: HTMLElement, active: boolean) => {
      el.classList.toggle("text-neutral-800", active);
      el.classList.toggle("text-neutral-500", !active);
    };
    setSeg(elSegTimer, view === "timer");
    setSeg(elSegStats, view === "stats");
    setSeg(elSegSettings, view === "settings");

    const posMap: Record<ViewKind, string> = {
      timer: "pos-0",
      stats: "pos-1",
      settings: "pos-2",
    };
    elSegSlider.className = `${SLIDER_BASE} ${posMap[view]}`;

    if (view === "stats") {
      void renderStats();
    }
  }

  elSegTimer.addEventListener("click", () => switchTo("timer"));
  elSegStats.addEventListener("click", () => switchTo("stats"));
  elSegSettings.addEventListener("click", () => switchTo("settings"));

  // Initial state: timer icon = active (darker)
  elSegTimer.classList.add("text-neutral-800");

  setupStatsNav();
}

// --- Stats ------------------------------------------------------------------
// A numeric placeholder: four figures for the selected window, no chart yet.

let statsPeriod: "week" | "month" | "year" = "week";
let statsOffset = 0;

function getDateRange(): { since: number; until: number; label: string } {
  const now = new Date();
  let since: Date;
  let until: Date;
  let label: string;

  if (statsPeriod === "week") {
    const dow = now.getDay();
    const monOff = dow === 0 ? -6 : 1 - dow;
    since = new Date(now);
    since.setDate(now.getDate() + monOff + statsOffset * 7);
    since.setHours(0, 0, 0, 0);
    until = new Date(since);
    until.setDate(since.getDate() + 7);
    const fmt = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const end = new Date(until);
    end.setDate(end.getDate() - 1);
    label = `${fmt(since)} – ${fmt(end)}, ${since.getFullYear()}`;
  } else if (statsPeriod === "month") {
    since = new Date(now.getFullYear(), now.getMonth() + statsOffset, 1);
    until = new Date(now.getFullYear(), now.getMonth() + statsOffset + 1, 1);
    label = since.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  } else {
    since = new Date(now.getFullYear() + statsOffset, 0, 1);
    until = new Date(now.getFullYear() + statsOffset + 1, 0, 1);
    label = String(since.getFullYear());
  }

  return { since: since.getTime(), until: until.getTime(), label };
}

function setRow(id: string, value: string): void {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

export async function renderStats(): Promise<void> {
  const { since, until, label } = getDateRange();

  setRow("stat-range-label", label);

  const elPrev = document.getElementById("stat-prev");
  const elNext = document.getElementById("stat-next");
  if (elNext) elNext.style.visibility = statsOffset === 0 ? "hidden" : "visible";
  if (elPrev) elPrev.style.visibility = "visible";

  let stats = { focusSec: 0, restSec: 0, sessions: 0 };
  try {
    stats = await getStatsBetween(since, until);
  } catch (e) {
    console.error("Failed to load stats:", e);
  }

  const totalSec = stats.focusSec + stats.restSec;
  const restPct = totalSec > 0 ? Math.round((stats.restSec / totalSec) * 100) : 0;
  const avgSec = stats.sessions > 0 ? Math.round(stats.focusSec / stats.sessions) : 0;

  setRow("stat-focus", stats.focusSec > 0 ? formatDuration(stats.focusSec) : "—");
  setRow("stat-sessions", stats.sessions > 0 ? String(stats.sessions) : "—");
  setRow("stat-average", avgSec > 0 ? formatDuration(avgSec) : "—");
  setRow("stat-rest", totalSec > 0 ? `${restPct}%` : "—");
}

export function setupStatsNav(): void {
  const buttons = [
    { el: document.getElementById("stat-week")!, period: "week" as const },
    { el: document.getElementById("stat-month")!, period: "month" as const },
    { el: document.getElementById("stat-year")!, period: "year" as const },
  ];

  const paint = (active: string) => {
    for (const { el, period } of buttons) {
      el.className =
        period === active
          ? "flex-1 h-8 rounded-xl bg-neutral-200 text-xs font-semibold text-neutral-800 cursor-pointer transition-colors"
          : "flex-1 h-8 rounded-xl text-xs text-neutral-500 hover:text-neutral-700 cursor-pointer transition-colors";
    }
  };

  for (const { el, period } of buttons) {
    el.addEventListener("click", () => {
      statsPeriod = period;
      statsOffset = 0;
      paint(period);
      void renderStats();
    });
  }
  paint(statsPeriod);

  document.getElementById("stat-prev")?.addEventListener("click", () => {
    statsOffset--;
    void renderStats();
  });
  document.getElementById("stat-next")?.addEventListener("click", () => {
    if (statsOffset >= 0) return;
    statsOffset++;
    void renderStats();
  });
}
