// Camera registry served from the bundled GeoJSON seed.
//
// System 2 (Tion-ping/system2-positioning-engine) intentionally does NOT
// expose a GET /cameras endpoint — its camera registry lives in
// `cameras.yaml` and is read at startup into the `camera_positions` table,
// which only `droneadmin` can read. The `system3_reader` role we share with
// System 3 has SELECT on `positions` only.
//
// So the seed IS the registry as far as System 3 is concerned. The previous
// version of this route proxied a phantom System 2 `/cameras` endpoint that
// always 404'd; we dropped it (commit: "frontend(api): drop /cameras
// proxy"). When System 1 or System 2 starts publishing a real registry
// endpoint, restore the proxy and gate the seed behind try/catch again.

import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";

type FeatureCollection = {
  type: "FeatureCollection";
  features: unknown[];
};

const SEED_RELATIVE_PATH = "public/data/cameras-seed.geojson";

export async function GET(): Promise<NextResponse> {
  const seedPath = path.join(process.cwd(), SEED_RELATIVE_PATH);
  const raw = await fs.readFile(seedPath, "utf8");
  const seed = JSON.parse(raw) as FeatureCollection;
  return NextResponse.json(seed, {
    // 15s is a compromise — the seed doesn't change between deploys, but
    // we don't want the SW to pin a stale cameras list across a rebuild.
    headers: { "Cache-Control": "public, max-age=15" },
  });
}
