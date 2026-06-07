// Server-only route that reads recent triangulated positions out of System 2's
// `positions` table (architecture: research/SYSTEM_2_STATE.md — "System 3
// polls detected positions from DB"). The pg pool lives in lib/pg-pool.ts
// behind `server-only`; nothing here ships to the browser.
//
// Contract: GET /api/positions?since=<ISO>&limit=<N>
//   - returns { positions: Position[] } sorted oldest-first within the window
//   - never 5xxs — DB unreachable or table missing returns an empty list with
//     a 200 + `degraded: true` flag so the dashboard's first paint isn't
//     gated on System 2 being up. The hook can show "no fixes" instead of
//     a red error toast on startup.

import { NextResponse } from "next/server";
import { pgPool } from "@/lib/pg-pool";

export const dynamic = "force-dynamic";

export type Position = {
  id: number;
  /** ISO-8601 UTC, from the detection events */
  timestamp: string;
  /** WGS84 */
  lat: number;
  lng: number;
  altM: number;
  /** e.g. "cam_01+cam_02" — passes through unchanged for the right panel */
  camPair: string;
  scoreI: number | null;
  scoreJ: number | null;
  insertedAt: string;
};

type Row = {
  id: number;
  timestamp: string | Date;
  lat: number;
  lon: number;
  alt_m: number;
  cam_pair: string;
  score_i: number | null;
  score_j: number | null;
  inserted_at: string | Date;
};

const DEFAULT_LIMIT = Number(process.env.POSITIONS_LIMIT ?? 200);

function row2position(r: Row): Position {
  return {
    id: r.id,
    timestamp:
      r.timestamp instanceof Date
        ? r.timestamp.toISOString()
        : String(r.timestamp),
    lat: r.lat,
    lng: r.lon,
    altM: r.alt_m,
    camPair: r.cam_pair,
    scoreI: r.score_i,
    scoreJ: r.score_j,
    insertedAt:
      r.inserted_at instanceof Date
        ? r.inserted_at.toISOString()
        : String(r.inserted_at),
  };
}

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const sinceParam = url.searchParams.get("since");
  const limit = Math.max(
    1,
    Math.min(1000, Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT)),
  );

  // `since` is the most-recent `inserted_at` the client already has; we only
  // ship strictly-newer rows. Falsy / unparseable → fall back to a 60s window
  // so the dashboard has *something* to draw on a cold load.
  const sinceDate = sinceParam ? new Date(sinceParam) : null;
  const sinceIso =
    sinceDate && !Number.isNaN(sinceDate.getTime())
      ? sinceDate.toISOString()
      : new Date(Date.now() - 60_000).toISOString();

  try {
    const pool = pgPool();
    const { rows } = await pool.query<Row>(
      `SELECT id, timestamp, lat, lon, alt_m, cam_pair, score_i, score_j, inserted_at
         FROM positions
        WHERE inserted_at > $1
        ORDER BY inserted_at ASC
        LIMIT $2`,
      [sinceIso, limit],
    );
    return NextResponse.json(
      { positions: rows.map(row2position), degraded: false },
      // Browser cache must NOT hold this — every poll asks the server.
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    // Don't crash the dashboard if System 2's Postgres isn't running locally.
    // Log on the server (visible in `npm run dev` output) so the operator
    // can see why fixes aren't arriving without inspecting devtools.
    console.warn("[/api/positions] db error:", (err as Error).message);
    return NextResponse.json(
      { positions: [], degraded: true },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }
}
