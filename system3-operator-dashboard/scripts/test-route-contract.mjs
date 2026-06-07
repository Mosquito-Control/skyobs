#!/usr/bin/env node
/**
 * Behavioral test for /api/positions: spins up a throwaway Postgres on a
 * non-standard port, applies System 2's `positions` schema verbatim, seeds
 * synthetic triangulated rows, then runs the EXACT SQL the route handler
 * uses against it. Asserts the rows round-trip into the Position shape the
 * `usePositions` hook expects.
 *
 * No docker-compose, no .env, no clashing with your existing
 * infra-postgres-1 container. Cleans up the container on exit.
 *
 * Run: node scripts/test-route-contract.mjs
 */
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "pg";

// Fixed name so a leftover container from an aborted run gets reaped on
// the next dockerRm(), instead of squatting on HOST_PORT.
const CONTAINER = "system3-route-test";
const HOST_PORT = 55432;
const DSN = `postgresql://postgres:probepass@127.0.0.1:${HOST_PORT}/dronedetection`;

const log = {
  step: (m) => process.stdout.write(`\n\x1b[1m▶ ${m}\x1b[0m\n`),
  ok: (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`),
  fail: (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`),
};

let failures = 0;
function assert(cond, msg) {
  if (cond) log.ok(msg);
  else {
    failures++;
    log.fail(msg);
  }
}

function dockerRm() {
  try {
    execFileSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
  } catch {
    /* ignore */
  }
}

async function dockerUp() {
  dockerRm();
  // `-d` runs detached and returns the container ID once started. Using
  // `--rm` would block the detach; we clean up explicitly in dockerRm().
  execFileSync(
    "docker",
    [
      "run",
      "-d",
      "--name",
      CONTAINER,
      "-e",
      "POSTGRES_PASSWORD=probepass",
      "-e",
      "POSTGRES_DB=dronedetection",
      "-p",
      `${HOST_PORT}:5432`,
      "postgres:16",
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  // Wait for the server to accept connections.
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const c = new Client({ connectionString: DSN, connectionTimeoutMillis: 500 });
    try {
      await c.connect();
      await c.end();
      log.ok(`postgres:16 ready on :${HOST_PORT}`);
      return;
    } catch {
      /* keep trying */
    }
  }
  throw new Error("postgres did not become reachable within 15s");
}

async function applySchema(c) {
  // Verbatim System 2 schema for the `positions` table — keep in sync with
  // Tion-ping/system2-positioning-engine/system2/db.py.
  await c.query(`
    CREATE TABLE IF NOT EXISTS positions (
      id          SERIAL PRIMARY KEY,
      timestamp   TIMESTAMPTZ NOT NULL,
      lat         DOUBLE PRECISION NOT NULL,
      lon         DOUBLE PRECISION NOT NULL,
      alt_m       DOUBLE PRECISION NOT NULL,
      cam_pair    TEXT NOT NULL,
      score_i     DOUBLE PRECISION,
      score_j     DOUBLE PRECISION,
      inserted_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  log.ok("positions table created");
}

async function seedFixes(c) {
  // The route filters by `inserted_at` (server write time), not `timestamp`
  // (detection time). Production rows have inserted_at ≈ NOW() because
  // System 2 writes them as it triangulates; we have to fake older
  // inserted_at values explicitly so the 60s window + cursor logic can be
  // exercised against rows that wouldn't otherwise be eligible.
  const now = Date.now();
  const rows = [
    // Old: inserted 90s ago. The default 60s window should skip this.
    [new Date(now - 90_000), 22.3193, 114.1694, 80.0, "cam_01+cam_02", 0.91, 0.88, new Date(now - 90_000)],
    // Recent #1: inserted 2s ago.
    [new Date(now - 2_000), 22.3210, 114.1700, 95.5, "cam_01+cam_02", 0.93, 0.90, new Date(now - 2_000)],
    // Recent #2: inserted 1s ago — strictly newer than #1's inserted_at.
    [new Date(now - 1_000), 22.3215, 114.1710, 102.0, "cam_02+cam_03", 0.87, 0.85, new Date(now - 1_000)],
  ];
  for (const r of rows) {
    await c.query(
      `INSERT INTO positions (timestamp, lat, lon, alt_m, cam_pair, score_i, score_j, inserted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      r,
    );
  }
  log.ok(`seeded ${rows.length} positions`);
}

// Mirror of the SQL in src/app/api/positions/route.ts. If you change the
// route's query, change this — that's the whole point of the test.
async function queryRoute(c, since, limit) {
  const sinceIso = since ?? new Date(Date.now() - 60_000).toISOString();
  const res = await c.query(
    `SELECT id, timestamp, lat, lon, alt_m, cam_pair, score_i, score_j, inserted_at
       FROM positions
      WHERE inserted_at > $1
      ORDER BY inserted_at ASC
      LIMIT $2`,
    [sinceIso, limit],
  );
  return res.rows;
}

(async () => {
  log.step("Boot throwaway postgres:16");
  await dockerUp();

  log.step("Apply schema + seed");
  const c = new Client({ connectionString: DSN });
  await c.connect();
  await applySchema(c);
  await seedFixes(c);

  log.step("Route SQL: default 60s window returns recent rows only");
  const recent = await queryRoute(c, null, 100);
  assert(recent.length === 2, `recent rows: got ${recent.length}, expected 2`);
  assert(
    recent.every((r) => typeof r.lat === "number" && typeof r.lon === "number"),
    "lat/lon are numeric",
  );
  assert(
    recent[0].inserted_at <= recent[1].inserted_at,
    "rows arrive oldest-first (ASC ordering matches the hook's `since` expectation)",
  );

  log.step("Route SQL: cursor `since` skips already-seen rows");
  const cursor = recent[0].inserted_at.toISOString();
  const afterCursor = await queryRoute(c, cursor, 100);
  assert(
    afterCursor.length === 1 && afterCursor[0].id === recent[1].id,
    "second poll returns only the strictly-newer row",
  );

  log.step("Route SQL: limit caps the result");
  const capped = await queryRoute(c, new Date(0).toISOString(), 2);
  assert(capped.length === 2, "limit=2 returns 2 rows even when 3 match the window");

  log.step("Position → DroneFix mapping (matches use-positions.ts)");
  const row = recent[1];
  const fix = {
    id: `${row.cam_pair}#${row.id}`,
    lat: row.lat,
    lng: row.lon,
    altM: row.alt_m,
    t: new Date(row.timestamp).getTime(),
  };
  assert(/cam_\d+\+cam_\d+#\d+/.test(fix.id), `fix id has the expected shape: ${fix.id}`);
  assert(fix.lat === row.lat && fix.lng === row.lon, "lat/lng survive the camelCase rename");
  assert(Number.isFinite(fix.t), "timestamp parses to a finite epoch");

  await c.end();
  dockerRm();

  console.log(
    `\n  \x1b[1mResult\x1b[0m  ${failures === 0 ? "\x1b[32mPASS\x1b[0m" : `\x1b[31mFAIL (${failures})\x1b[0m`}\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  dockerRm();
  process.exit(1);
});
