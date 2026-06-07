// Server-only route reading System 4's tracking results out of the shared
// Azure PostgreSQL. System 4 writes to `tracks` + `track_points`; this route
// is the read side — same pattern as /api/positions.
//
// Contract: GET /api/tracks?window_m=<N>&trail_points=<N>
//   - window_m: how many minutes back to look for recent tracks (default 5)
//   - trail_points: max historical points per track trail (default 50)
//   - returns { tracks: Track[], degraded: boolean }
//   - never 5xxs — tables missing (pre-migration) returns empty + degraded:true

import { NextResponse } from "next/server";
import { pgPool } from "@/lib/pg-pool";
import type { Track, TrackPoint } from "@/lib/types";

export const dynamic = "force-dynamic";

type TrackRow = {
  id: number;
  status: string;
  first_seen: string | Date;
  last_seen: string | Date;
  last_lat: number;
  last_lon: number;
  last_alt_m: number;
  point_count: number;
};

type PointRow = {
  track_id: number;
  lat: number;
  lon: number;
  alt_m: number;
  timestamp: string | Date;
};

function toIso(v: string | Date): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const windowM = Math.max(1, Math.min(60, Number(url.searchParams.get("window_m") ?? 5)));
  const trailPoints = Math.max(1, Math.min(200, Number(url.searchParams.get("trail_points") ?? 50)));

  try {
    const pool = pgPool();

    const { rows: trackRows } = await pool.query<TrackRow>(
      `SELECT id, status, first_seen, last_seen, last_lat, last_lon, last_alt_m, point_count
         FROM tracks
        WHERE last_seen > NOW() - ($1 || ' minutes')::INTERVAL
        ORDER BY last_seen DESC`,
      [String(windowM)],
    );

    if (trackRows.length === 0) {
      return NextResponse.json(
        { tracks: [], degraded: false },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    const trackIds = trackRows.map((r) => r.id);

    // Fetch the most-recent trail points per track via a window function so
    // we get at most `trailPoints` per track without N+1 queries.
    const { rows: pointRows } = await pool.query<PointRow>(
      `WITH ranked AS (
         SELECT track_id, lat, lon, alt_m, timestamp,
                ROW_NUMBER() OVER (PARTITION BY track_id ORDER BY inserted_at DESC) AS rn
         FROM track_points
         WHERE track_id = ANY($1::int[])
       )
       SELECT track_id, lat, lon, alt_m, timestamp
       FROM ranked
       WHERE rn <= $2
       ORDER BY track_id, timestamp ASC`,
      [trackIds, trailPoints],
    );

    // Group trail points by track_id
    const trailByTrack: Record<number, TrackPoint[]> = {};
    for (const p of pointRows) {
      const t = new Date(toIso(p.timestamp)).getTime();
      if (!trailByTrack[p.track_id]) trailByTrack[p.track_id] = [];
      trailByTrack[p.track_id].push({ lat: p.lat, lon: p.lon, altM: p.alt_m, t });
    }

    const tracks: Track[] = trackRows.map((r) => ({
      id: r.id,
      status: (r.status === "active" || r.status === "lost" ? r.status : "lost") as Track["status"],
      firstSeen: toIso(r.first_seen),
      lastSeen: toIso(r.last_seen),
      lastLat: r.last_lat,
      lastLon: r.last_lon,
      lastAltM: r.last_alt_m,
      pointCount: r.point_count,
      trail: trailByTrack[r.id] ?? [],
    }));

    return NextResponse.json(
      { tracks, degraded: false },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    // Tables don't exist yet (pre-migration) or DB is down — degrade gracefully.
    console.warn("[/api/tracks] db error:", (err as Error).message);
    return NextResponse.json(
      { tracks: [], degraded: true },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }
}
