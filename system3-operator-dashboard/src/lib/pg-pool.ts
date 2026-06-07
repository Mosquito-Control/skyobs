import "server-only";

import { Pool } from "pg";

// Module-scope singleton — Next.js can re-evaluate route handlers per request
// in dev, but the module cache survives between invocations, so we only ever
// have one pool per server process. The route handler reuses idle connections
// instead of paying the TCP+auth handshake on every poll tick.

declare global {
  // eslint-disable-next-line no-var
  var __dronePgPool: Pool | undefined;
}

// Matches System 2's docker-compose default: read-only role granted SELECT on
// `positions` only. Wrong creds are loud (auth failure), but with no env at
// all we silently hit the right local stack. That's the "everything runs
// locally" contract — zero ceremony to get a green probe.
const DEFAULT_LOCAL_DSN =
  "postgresql://system3_reader:system3reader@localhost:5432/dronedetection";

export function pgPool(): Pool {
  if (!globalThis.__dronePgPool) {
    const url = process.env.DATABASE_URL ?? DEFAULT_LOCAL_DSN;
    globalThis.__dronePgPool = new Pool({
      connectionString: url,
      // Tight bounds — System 3 only polls SELECTs at ~1Hz; we don't need a
      // large pool. Two connections cover the route handler running in
      // parallel with the probe script.
      max: 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 2_000,
    });
  }
  return globalThis.__dronePgPool;
}
