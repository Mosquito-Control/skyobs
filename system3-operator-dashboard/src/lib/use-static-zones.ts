"use client";

// Read-only feed for HK's bundled permanent no-fly polygons. The map overlay
// (hk-no-fly-layer) is the visual consumer; the zone panel uses this hook
// purely to surface the PERM count so the badge reflects reality (airport +
// country parks + military) before the operator has drawn anything.
//
// Kept OUT of the zustand store on purpose — these features are immutable,
// shouldn't be undoable, and shouldn't bloat every temporal snapshot.

import { useQuery } from "@tanstack/react-query";

const DATA_URL = "/data/hk-permanent-zones.geojson";

export type StaticZoneEntry = {
  id: string;
  name: string;
  category: string;
};

type StaticZoneSummary = {
  count: number;
  entries: StaticZoneEntry[];
};

type RawFeature = {
  id?: string | number;
  properties?: { name?: string; category?: string } | null;
};

async function fetchStaticZones({
  signal,
}: {
  signal?: AbortSignal;
}): Promise<StaticZoneSummary> {
  // no-store — we rewrite this geojson at build/dev time and force-cache
  // pinned the browser to the pre-merge version after every regenerate.
  const res = await fetch(DATA_URL, { signal, cache: "no-store" });
  if (!res.ok) throw new Error(`hk-permanent-zones ${res.status}`);
  const data = (await res.json()) as { features?: RawFeature[] };
  const features = Array.isArray(data.features) ? data.features : [];
  const entries: StaticZoneEntry[] = features.map((f, i) => {
    const category = f.properties?.category ?? "custom";
    const name =
      f.properties?.name ??
      `${category.charAt(0).toUpperCase() + category.slice(1)} zone ${i + 1}`;
    // Must match the fallback in hk-no-fly-layer.tsx — the map source uses
    // `hk-${idx}` for features missing an `id` (HK approach-area polygons),
    // and panel toggles/selections key off this id via the shared store.
    const rawId = f.id ?? `hk-${i}`;
    return { id: String(rawId), name, category };
  });
  return { count: entries.length, entries };
}

export function useStaticZones() {
  return useQuery({
    queryKey: ["static-zones"],
    queryFn: ({ signal }) => fetchStaticZones({ signal }),
    // Bundled asset; never goes stale within a session.
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  });
}
