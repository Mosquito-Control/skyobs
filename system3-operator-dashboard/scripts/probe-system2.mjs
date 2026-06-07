#!/usr/bin/env node
/**
 * End-to-end probe against a locally-running stack. No mocking — this hits
 * the real System 2 API + Postgres + the dashboard's /api/positions route
 * and prints what each tier reports. Exits 0 even if upstreams are down,
 * because graceful degradation is the contract; non-zero only on a malformed
 * response from /api/positions (which would mean the frontend itself is
 * broken).
 *
 * Run from Orgs/frontend with `node scripts/probe-system2.mjs`. Tunable via:
 *   SYSTEM2_API_URL       (default http://localhost:8000)
 *   DATABASE_URL          (default postgresql://system3_reader:system3reader@localhost:5432/dronedetection)
 *   FRONTEND_URL          (default http://localhost:3187)
 *   SEED                  (set "1" to insert a synthetic position row before
 *                          the probe so /api/positions returns non-empty)
 */
import { Client } from "pg";

const SYSTEM2_API_URL = process.env.SYSTEM2_API_URL ?? "http://localhost:8000";
const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://system3_reader:system3reader@localhost:5432/dronedetection";
const FRONTEND_URL = process.env.FRONTEND_URL ?? "http://localhost:3187";

const log = {
  step: (m) => process.stdout.write(`\n\x1b[1m▶ ${m}\x1b[0m\n`),
  ok: (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`),
  warn: (m) => console.log(`  \x1b[33m⚠\x1b[0m ${m}`),
  fail: (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`),
};

const summary = { pass: 0, warn: 0, fail: 0 };
function pass(m) { summary.pass++; log.ok(m); }
function warn(m) { summary.warn++; log.warn(m); }
function fail(m) { summary.fail++; log.fail(m); }

async function probeSystem2Health() {
  log.step(`System 2 health — ${SYSTEM2_API_URL}/health`);
  try {
    const res = await fetch(`${SYSTEM2_API_URL}/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) {
      warn(`/health returned ${res.status} — System 2 is up but unhealthy`);
      return false;
    }
    const body = await res.json();
    pass(`status=${body.status} cache_size=${body.cache_size}`);
    return true;
  } catch (e) {
    warn(`/health unreachable: ${e.message} — run docker-compose up in system2`);
    return false;
  }
}

async function probePostgres() {
  log.step(`Postgres direct — ${DATABASE_URL.replace(/:[^:@]*@/, ":***@")}`);
  const client = new Client({ connectionString: DATABASE_URL });
  try {
    await client.connect();
    pass("connection established");
  } catch (e) {
    warn(`connect failed: ${e.message} — is system3_reader granted on this db?`);
    return null;
  }

  try {
    if (process.env.SEED === "1") {
      // SEED requires droneadmin; system3_reader will reject. We try anyway
      // so the probe can be re-run with admin creds to populate data.
      try {
        await client.query(
          `INSERT INTO positions (timestamp, lat, lon, alt_m, cam_pair, score_i, score_j)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            new Date().toISOString(),
            22.3193 + Math.random() * 0.02,
            114.1694 + Math.random() * 0.02,
            80 + Math.random() * 60,
            "cam_01+cam_02",
            0.91,
            0.88,
          ],
        );
        pass("seeded 1 synthetic position row");
      } catch (e) {
        warn(`seed INSERT failed (expected on system3_reader): ${e.message}`);
      }
    }

    const recent = await client.query(
      "SELECT count(*)::int AS n FROM positions WHERE inserted_at > NOW() - INTERVAL '5 minutes'",
    );
    pass(`positions inserted in the last 5 minutes: ${recent.rows[0].n}`);

    const total = await client.query("SELECT count(*)::int AS n FROM positions");
    pass(`positions rows total: ${total.rows[0].n}`);

    const last = await client.query(
      "SELECT id, lat, lon, alt_m, cam_pair, inserted_at FROM positions ORDER BY inserted_at DESC LIMIT 3",
    );
    if (last.rows.length === 0) {
      warn("table is empty — no triangulated fixes yet (System 1 not sending?)");
    } else {
      for (const r of last.rows) {
        log.ok(
          `id=${r.id} (${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}) ${r.alt_m.toFixed(1)}m ${r.cam_pair} @ ${r.inserted_at}`,
        );
      }
    }
    return total.rows[0].n;
  } catch (e) {
    fail(`query failed: ${e.message}`);
    return null;
  } finally {
    await client.end().catch(() => {});
  }
}

async function probeFrontendRoute() {
  log.step(`Frontend route — ${FRONTEND_URL}/api/positions`);
  try {
    const res = await fetch(`${FRONTEND_URL}/api/positions?limit=5`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) {
      fail(`/api/positions returned ${res.status} — frontend is wired but the route is broken`);
      return;
    }
    const body = await res.json();
    if (!Array.isArray(body.positions) || typeof body.degraded !== "boolean") {
      fail(`malformed response: ${JSON.stringify(body).slice(0, 200)}`);
      return;
    }
    if (body.degraded) {
      warn(`route returns degraded:true → DB unreachable from the dev server`);
    } else {
      pass(`route returned ${body.positions.length} position(s), degraded=false`);
      if (body.positions[0]) {
        const p = body.positions[0];
        log.ok(`first: id=${p.id} (${p.lat}, ${p.lng}) ${p.altM}m camPair=${p.camPair}`);
      }
    }
  } catch (e) {
    warn(`unreachable: ${e.message} — start the dashboard with \`npm run dev\``);
  }
}

(async () => {
  log.step("Probe — Tion-ping/system3 ↔ system2 ↔ postgres");
  console.log(
    `  Local stack expected: System 2 docker-compose up + \`npm run dev\` here.\n`,
  );

  await probeSystem2Health();
  await probePostgres();
  await probeFrontendRoute();

  console.log(
    `\n  \x1b[1mSummary\x1b[0m  pass=${summary.pass} warn=${summary.warn} fail=${summary.fail}`,
  );
  process.exit(summary.fail > 0 ? 1 : 0);
})();
