#!/usr/bin/env node
/**
 * Build Hong Kong static permanent no-fly polygons into a single GeoJSON file.
 *
 * Sources:
 *   - Chek Lap Kok airport (OSM relation 16105017) via Overpass
 *   - HKIA approach areas via ESRI China Open Data
 *   - HK country parks via Overpass [boundary=national_park]
 *   - Shek Kong Airfield military area (OSM way 160073829)
 *
 * Output: public/data/hk-permanent-zones.geojson
 *
 * Each feature gets a `category` property: 'airport' | 'approach-area' |
 * 'country-park' | 'military'. If a remote source fails, that category is
 * skipped and the script exits 0 with a log line.
 *
 * Run with: node scripts/build-hk-data.mjs (or `npm run data:hk`).
 */

import { writeFile, mkdir, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { simplify } from "@turf/turf";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const OUT_PATH = resolve(
  __dirname,
  "..",
  "public",
  "data",
  "hk-permanent-zones.geojson",
);

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.fr/api/interpreter",
];

const ESRI_HKIA_URL =
  "https://opendata.esrichina.hk/api/download/v1/items/38a75b5339514f58a08bdca25f51c9e8/geojson?layers=0";

/** Fetch with a timeout — node's global fetch has no built-in timeout. */
async function fetchWithTimeout(url, init = {}, timeoutMs = 30_000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

/**
 * POST an Overpass QL query and return parsed JSON. Tries multiple mirrors and
 * retries once with a longer timeout on the first endpoint if it times out.
 */
async function overpass(query, { label }) {
  let lastErr;
  // Overpass expects either GET ?data= or POST application/x-www-form-urlencoded
  // with `data=...`. Using text/plain returns 406/400 on some mirrors.
  const body = new URLSearchParams({ data: query }).toString();
  for (let attempt = 0; attempt < 2; attempt++) {
    const timeoutMs = attempt === 0 ? 30_000 : 60_000;
    for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        const res = await fetchWithTimeout(
          endpoint,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              "User-Agent": "hk-drone-airspace-build/1.0 (+local)",
              Accept: "application/json",
            },
            body,
          },
          timeoutMs,
        );
        if (!res.ok) {
          lastErr = new Error(`Overpass ${endpoint} → ${res.status}`);
          console.warn(
            `[${label}] overpass ${endpoint} attempt ${attempt + 1} → ${res.status}`,
          );
          continue;
        }
        const json = await res.json();
        return json;
      } catch (err) {
        lastErr = err;
        console.warn(
          `[${label}] overpass ${endpoint} attempt ${attempt + 1} failed: ${err?.message ?? err}`,
        );
      }
    }
  }
  throw lastErr ?? new Error("All overpass endpoints failed");
}

/**
 * Convert raw Overpass JSON to GeoJSON FeatureCollection by shelling out to
 * the `osmtogeojson` CLI via `npx -y` (per task spec). The CLI requires a
 * FILE arg, so we write the input to a temp file first.
 */
async function osmToGeoJSON(osmJson, label) {
  const tmpPath = resolve(
    tmpdir(),
    `osm-${label}-${randomBytes(6).toString("hex")}.json`,
  );
  await writeFile(tmpPath, JSON.stringify(osmJson), "utf8");
  try {
    return await new Promise((resolveP, rejectP) => {
      const child = execFile(
        "npx",
        ["-y", "osmtogeojson", "-f", "json", "-m", tmpPath],
        { maxBuffer: 256 * 1024 * 1024 },
      );
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (c) => (stdout += c));
      child.stderr?.on("data", (c) => (stderr += c));
      child.on("error", rejectP);
      child.on("close", (code) => {
        if (code !== 0) {
          rejectP(
            new Error(
              `osmtogeojson [${label}] exited ${code}: ${stderr.slice(0, 400)}`,
            ),
          );
          return;
        }
        try {
          resolveP(JSON.parse(stdout));
        } catch (e) {
          rejectP(e);
        }
      });
    });
  } finally {
    unlink(tmpPath).catch(() => {});
  }
}

/**
 * Reduce coordinate precision in-place to ~5dp (≈1 m) so the bundle stays
 * under the 500 KB budget without visible loss at city zoom levels.
 */
function trimPrecision(features, dp = 5) {
  const m = 10 ** dp;
  const round = (n) => Math.round(n * m) / m;
  const walk = (c) => {
    if (typeof c[0] === "number") {
      c[0] = round(c[0]);
      c[1] = round(c[1]);
    } else {
      for (const inner of c) walk(inner);
    }
  };
  for (const f of features) {
    if (!f?.geometry?.coordinates) continue;
    walk(f.geometry.coordinates);
  }
}

/** Keep only polygonal geometries — discard nodes/lines that slip through. */
function onlyPolygons(features) {
  return features.filter(
    (f) =>
      f?.geometry?.type === "Polygon" || f?.geometry?.type === "MultiPolygon",
  );
}

/**
 * Douglas-Peucker simplify each feature in place. `tolerance` is in degrees;
 * 0.0005° ≈ 50 m at HK latitudes — invisible at the zooms we paint at, but
 * collapses OSM's high-density vertex chains massively.
 */
function simplifyFeatures(features, tolerance) {
  const out = [];
  for (const f of features) {
    try {
      const simplified = simplify(f, {
        tolerance,
        highQuality: false,
        mutate: false,
      });
      // simplify may return a geometry with 0 rings if collapsed — skip those.
      const g = simplified?.geometry;
      if (!g) continue;
      if (
        (g.type === "Polygon" && g.coordinates?.[0]?.length >= 4) ||
        (g.type === "MultiPolygon" &&
          g.coordinates?.some((p) => p?.[0]?.length >= 4))
      ) {
        out.push(simplified);
      }
    } catch {
      // simplify throws on degenerate rings — keep original as fallback.
      out.push(f);
    }
  }
  return out;
}

/**
 * Strip OSM metadata bloat — keep only display name + category, which is all
 * the map paint expressions look at. Saves ~60% bundle size on country parks.
 */
function tag(features, category) {
  for (const f of features) {
    const p = f.properties ?? {};
    const name =
      p["name:en"] ?? p.name ?? p["name:zh"] ?? p.NAME ?? p.Name ?? null;
    f.properties = name ? { name, category } : { category };
  }
  return features;
}

async function buildAirport() {
  const q = `[out:json][timeout:60];relation(16105017);out geom;`;
  const osm = await overpass(q, { label: "airport" });
  const gj = await osmToGeoJSON(osm, "airport");
  return tag(onlyPolygons(gj.features ?? []), "airport");
}

async function buildMilitary() {
  const q = `[out:json][timeout:60];way(160073829);(._;>;);out geom;`;
  const osm = await overpass(q, { label: "military" });
  const gj = await osmToGeoJSON(osm, "military");
  return tag(onlyPolygons(gj.features ?? []), "military");
}

async function buildCountryParks() {
  const q = `[out:json][timeout:180];relation["boundary"="national_park"](22.15,113.83,22.57,114.42);out geom;`;
  const osm = await overpass(q, { label: "country-park" });
  const gj = await osmToGeoJSON(osm, "country-park");
  return tag(onlyPolygons(gj.features ?? []), "country-park");
}

async function buildApproachAreas() {
  // ESRI China Open Data sometimes responds slowly — retry once at 60 s.
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const timeoutMs = attempt === 0 ? 30_000 : 60_000;
    try {
      const res = await fetchWithTimeout(ESRI_HKIA_URL, {}, timeoutMs);
      if (!res.ok) {
        lastErr = new Error(`ESRI HKIA → ${res.status}`);
        continue;
      }
      const gj = await res.json();
      return tag(onlyPolygons(gj.features ?? []), "approach-area");
    } catch (err) {
      lastErr = err;
      console.warn(
        `[approach-area] attempt ${attempt + 1} failed: ${err?.message ?? err}`,
      );
    }
  }
  throw lastErr ?? new Error("ESRI HKIA fetch failed");
}

const TASKS = [
  { name: "airport", fn: buildAirport },
  { name: "approach-area", fn: buildApproachAreas },
  { name: "country-park", fn: buildCountryParks },
  { name: "military", fn: buildMilitary },
];

async function main() {
  /** @type {Array<{name: string, count: number}>} */
  const succeeded = [];
  const skipped = [];
  /** @type {any[]} */
  const merged = [];

  // Run sequentially — Overpass is rate-limited and parallel hits get throttled.
  for (const { name, fn } of TASKS) {
    try {
      console.log(`[${name}] fetching…`);
      const feats = await fn();
      console.log(`[${name}] got ${feats.length} polygon feature(s)`);
      merged.push(...feats);
      succeeded.push({ name, count: feats.length });
    } catch (err) {
      console.warn(
        `[${name}] SKIPPED — ${err?.message ?? err}`,
      );
      skipped.push(name);
    }
  }

  // Douglas-Peucker first (~50 m tolerance), then trim to 4 dp (~11 m). Together
  // they hit the <500 KB target without visible loss at the zooms we paint at.
  const simplified = simplifyFeatures(merged, 0.0005);
  trimPrecision(simplified, 4);
  merged.length = 0;
  merged.push(...simplified);

  const fc = {
    type: "FeatureCollection",
    metadata: {
      generatedAt: new Date().toISOString(),
      categoriesIncluded: succeeded.map((s) => s.name),
      categoriesSkipped: skipped,
    },
    features: merged,
  };

  await mkdir(dirname(OUT_PATH), { recursive: true });
  const body = JSON.stringify(fc);
  await writeFile(OUT_PATH, body, "utf8");

  const bytes = Buffer.byteLength(body, "utf8");
  console.log(
    `\nWrote ${OUT_PATH}\n  features: ${merged.length}\n  size: ${bytes} bytes (${(bytes / 1024).toFixed(1)} KB)\n  succeeded: ${succeeded.map((s) => `${s.name}(${s.count})`).join(", ") || "none"}\n  skipped: ${skipped.join(", ") || "none"}`,
  );

  // Always exit 0 — partial output is acceptable per spec.
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
