import Database from "@tauri-apps/plugin-sql";

// flowtime+ is its own app: it never reads or writes the original amble database.
const DB_NAME = import.meta.env.DEV ? "flowtime-plus-dev.db" : "flowtime-plus.db";

let db: Database | null = null;

async function getDb(): Promise<Database> {
  if (!db) {
    db = await Database.load(`sqlite:${DB_NAME}`);
    try {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS time_blocks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          block_type TEXT NOT NULL,
          start_time INTEGER NOT NULL,
          end_time INTEGER NOT NULL,
          duration INTEGER NOT NULL,
          earned_rest_duration INTEGER DEFAULT 0,
          is_manual INTEGER DEFAULT 0,
          tag TEXT,
          note TEXT,
          created_at INTEGER NOT NULL
        )
      `);
    } catch (e) {
      console.error("Failed to create tables:", e);
    }
  }
  return db;
}

function msToSec(ms: number): number {
  return Math.round(ms / 1000);
}

// --- Session journal --------------------------------------------------------

export async function saveSession(data: {
  workStartTime: number;
  workEndTime: number;
  workDurationMs: number;
  restTargetMs: number;
  restStartTime: number;
  restEndTime: number;
  restDurationMs: number;
  ratio: number;
}): Promise<void> {
  const d = await getDb();
  const now = Date.now();

  await d.execute(
    `INSERT INTO time_blocks (block_type, start_time, end_time, duration, earned_rest_duration, is_manual, created_at)
     VALUES ('work', $1, $2, $3, $4, 0, $5)`,
    [
      data.workStartTime,
      data.workEndTime,
      msToSec(data.workDurationMs),
      msToSec(data.restTargetMs),
      now,
    ],
  );

  if (data.restStartTime > 0 && data.restEndTime > 0) {
    await d.execute(
      `INSERT INTO time_blocks (block_type, start_time, end_time, duration, earned_rest_duration, is_manual, created_at)
       VALUES ('rest', $1, $2, $3, $4, 0, $5)`,
      [
        data.restStartTime,
        data.restEndTime,
        msToSec(data.restDurationMs),
        msToSec(data.restTargetMs),
        now,
      ],
    );
  }
}

// --- Statistics -------------------------------------------------------------
// One aggregate for an explicit window. The panel currently renders these as
// plain figures; there is deliberately no chart yet.

export interface StatsResult {
  focusSec: number;
  restSec: number;
  sessions: number;
}

export async function getStatsBetween(since: number, until: number): Promise<StatsResult> {
  const d = await getDb();

  const rows = await d.select<Array<{ kind: string; total: number; n: number }>>(
    `SELECT block_type AS kind,
            COALESCE(SUM(duration), 0) AS total,
            COUNT(*) AS n
       FROM time_blocks
      WHERE start_time >= $1 AND start_time < $2
      GROUP BY block_type`,
    [since, until],
  );

  let focusSec = 0;
  let restSec = 0;
  let sessions = 0;

  for (const row of rows) {
    if (row.kind === "work") {
      focusSec = row.total;
      sessions = row.n;
    } else if (row.kind === "rest") {
      restSec = row.total;
    }
  }

  return { focusSec, restSec, sessions };
}

// --- Formatting -------------------------------------------------------------

export function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}
