"use client";

import { useQuery } from "@tanstack/react-query";

export type CameraFeature = {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: {
    source: string;
    source_key: string;
    name: string;
    monitored?: boolean;
    sky_score?: number;
    status?: string;
    focal_px?: number;
    last_seen_at?: string | null;
  };
};

export type CameraFeatureCollection = {
  type: "FeatureCollection";
  features: CameraFeature[];
};

async function fetchCameras({
  signal,
}: {
  signal?: AbortSignal;
}): Promise<CameraFeatureCollection> {
  const res = await fetch("/api/cameras", { signal });
  if (!res.ok) throw new Error(`/api/cameras ${res.status}`);
  return (await res.json()) as CameraFeatureCollection;
}

export function useCameras() {
  return useQuery({
    queryKey: ["cameras"],
    // Forward TanStack Query's AbortSignal so an unmount/invalidation cancels
    // the in-flight fetch instead of stranding the network round-trip.
    queryFn: ({ signal }) => fetchCameras({ signal }),
    // Matches the route handler's max-age — refetching faster than the upstream
    // refreshes would just churn the layer.
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
}
