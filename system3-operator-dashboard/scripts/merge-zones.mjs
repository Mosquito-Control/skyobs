#!/usr/bin/env node
/**
 * Rewrites public/data/hk-permanent-zones.geojson:
 *   1. Union the airport polygon with every approach-area feature into one
 *      "Hong Kong International Airport" feature.
 *   2. Transitively union ALL touching / overlapping country-park features —
 *      not just name-based "X + X Extension" pairs. Anything that intersects
 *      its neighbour gets folded into a single zone via connected-components.
 *   3. Append a handful of HK downtown no-fly bboxes (Central, Admiralty,
 *      Wan Chai, Causeway Bay, TST, Mong Kok, Kowloon Bay Stadium, Tamar
 *      Park).
 *
 * Run from Orgs/frontend with `node scripts/merge-zones.mjs`. Restore the
 * pre-merge data from `public/data/hk-permanent-zones.geojson.bak` if needed.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { union } from "@turf/union";
import { featureCollection } from "@turf/helpers";
import { bboxPolygon } from "@turf/bbox-polygon";
import { booleanIntersects } from "@turf/boolean-intersects";
import { simplify } from "@turf/simplify";
import { polygonSmooth } from "@turf/polygon-smooth";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.resolve(__dirname, "../public/data/hk-permanent-zones.geojson");

const data = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
const features = data.features ?? [];

// ---- 1. Airport + approach areas → one polygon ---------------------------
const airport = features.find((f) => f.properties?.category === "airport");
const approaches = features.filter(
  (f) => f.properties?.category === "approach-area",
);
if (!airport) throw new Error("no airport feature in source");

const airportUnion = union(featureCollection([airport, ...approaches]));
if (!airportUnion) throw new Error("airport union returned null");
airportUnion.id = airport.id ?? "relation/16105017";
airportUnion.properties = {
  name: "Hong Kong International Airport",
  category: "airport",
};

// ---- 2. Transitive country-park union ------------------------------------
const parks = features.filter((f) => f.properties?.category === "country-park");

// Union-find on park indices. Edge = "the two polygons intersect" — turf's
// booleanIntersects returns true for both overlap and edge-touching, so
// extensions, mountain ridges that share a boundary, and any actually-
// overlapping pair all collapse into the same component.
const parent = parks.map((_, i) => i);
const find = (i) => {
  while (parent[i] !== i) {
    parent[i] = parent[parent[i]];
    i = parent[i];
  }
  return i;
};
const unite = (a, b) => {
  const ra = find(a);
  const rb = find(b);
  if (ra !== rb) parent[ra] = rb;
};

console.log(`[merge] scanning ${parks.length} parks for adjacency...`);
let edgeCount = 0;
for (let i = 0; i < parks.length; i++) {
  for (let j = i + 1; j < parks.length; j++) {
    try {
      if (booleanIntersects(parks[i], parks[j])) {
        unite(i, j);
        edgeCount++;
      }
    } catch (e) {
      console.warn(`[merge] intersect failed for ${i},${j}: ${e.message}`);
    }
  }
}
console.log(`[merge] adjacency edges found: ${edgeCount}`);

// Group by component root.
const groups = new Map();
for (let i = 0; i < parks.length; i++) {
  const root = find(i);
  if (!groups.has(root)) groups.set(root, []);
  groups.get(root).push(i);
}

// Materialize union per component. Single-park components pass through.
const parkOutput = [];
let groupsMerged = 0;
for (const [, indices] of groups) {
  if (indices.length === 1) {
    parkOutput.push(parks[indices[0]]);
    continue;
  }
  const members = indices.map((i) => parks[i]);
  const merged = union(featureCollection(members));
  if (!merged) {
    console.warn("[merge] union returned null for a group — keeping members");
    parkOutput.push(...members);
    continue;
  }
  // Name = longest common prefix of member names, fallback to first member
  // name + " (merged)". Quick and good enough for the demo.
  const names = members.map((m) => m.properties?.name ?? "Country Park");
  let prefix = names[0];
  for (const n of names) {
    let k = 0;
    while (k < prefix.length && k < n.length && prefix[k] === n[k]) k++;
    prefix = prefix.slice(0, k);
  }
  prefix = prefix.trim().replace(/[(\-,]+$/g, "").trim();
  const label =
    prefix && prefix.length >= 4 ? prefix : `${names[0]} (+${names.length - 1})`;
  merged.id = members[0].id ?? `park-merge-${parkOutput.length}`;
  merged.properties = { name: label, category: "country-park" };
  parkOutput.push(merged);
  groupsMerged++;
  console.log(
    `[merge] union ${members.length} → ${label} (members: ${names.join(", ")})`,
  );
}
console.log(
  `[merge] parks: ${parks.length} → ${parkOutput.length} (${groupsMerged} groups merged)`,
);

// ---- 3. New downtown no-fly bboxes ---------------------------------------
// Each box: [west, south, east, north]. Tightly fitted around the actual
// districts — not real published airspace, placeholders for the demo.
const CITY_ZONES = [
  {
    name: "Central — Government / Finance District",
    category: "vip",
    bbox: [114.152, 22.275, 114.168, 22.288],
  },
  {
    name: "Admiralty / Tamar Park",
    category: "vip",
    bbox: [114.163, 22.276, 114.173, 22.286],
  },
  {
    name: "Wan Chai Convention Centre",
    category: "event",
    bbox: [114.170, 22.278, 114.182, 22.286],
  },
  {
    name: "Causeway Bay",
    category: "event",
    bbox: [114.178, 22.276, 114.190, 22.286],
  },
  {
    name: "Tsim Sha Tsui Waterfront",
    category: "event",
    bbox: [114.166, 22.292, 114.180, 22.303],
  },
  {
    name: "Mong Kok",
    category: "event",
    bbox: [114.163, 22.314, 114.176, 22.326],
  },
  {
    name: "Kowloon Bay Sports Ground",
    category: "event",
    bbox: [114.205, 22.318, 114.218, 22.328],
  },
  {
    name: "West Kowloon Cultural District",
    category: "event",
    bbox: [114.155, 22.296, 114.167, 22.308],
  },
];
const cityFeatures = CITY_ZONES.map((z, i) => {
  const f = bboxPolygon(z.bbox);
  f.id = `city-${i}`;
  f.properties = { name: z.name, category: z.category };
  return f;
});

// ---- 3b. Smooth every polygon --------------------------------------------
// Raw OSM relations are extremely jagged at HK's scale. The pipeline:
//   simplify(tolerance=0.0008) — drop vertices that don't carry shape info
//     (~80m at HK latitude). Aggressive enough that fingerprint-level
//     wiggles disappear without losing real bays/peninsulas.
//   polygonSmooth(iterations=2) — Chaikin corner-cutting twice. Two passes
//     is enough to look hand-drawn; three+ explodes vertex count for
//     marginal gain.
// City bboxes are intentionally NOT smoothed — sharp downtown rectangles
// read as "deliberate restricted zone" vs "natural feature".
function smoothFeature(f) {
  if (
    f.geometry?.type !== "Polygon" &&
    f.geometry?.type !== "MultiPolygon"
  ) {
    return f;
  }
  let working = f;
  try {
    working = simplify(working, { tolerance: 0.0008, highQuality: true });
  } catch (e) {
    console.warn(`[smooth] simplify failed for ${f.properties?.name}: ${e.message}`);
  }
  try {
    const smoothed = polygonSmooth(working, { iterations: 2 });
    const out = smoothed?.features?.[0];
    if (out) {
      out.id = f.id;
      out.properties = f.properties;
      return out;
    }
  } catch (e) {
    console.warn(`[smooth] polygonSmooth failed for ${f.properties?.name}: ${e.message}`);
  }
  return working;
}

const kept = features.filter((f) => {
  const cat = f.properties?.category;
  if (cat === "airport") return false;
  if (cat === "approach-area") return false;
  if (cat === "country-park") return false; // replaced by parkOutput
  return true;
});

const smoothedAirport = smoothFeature(airportUnion);
const smoothedParks = parkOutput.map(smoothFeature);
const smoothedKept = kept.map(smoothFeature);

// ---- 4. Stitch the new collection ----------------------------------------

const next = {
  type: "FeatureCollection",
  metadata: {
    ...data.metadata,
    transformedAt: "build-time",
    note: "Airport+approaches unioned; touching parks transitively unioned; downtown zones added.",
  },
  features: [smoothedAirport, ...smoothedParks, ...smoothedKept, ...cityFeatures],
};

fs.writeFileSync(DATA_PATH, JSON.stringify(next, null, 2) + "\n");

console.log(
  `[merge] total features: ${features.length} → ${next.features.length}`,
);
