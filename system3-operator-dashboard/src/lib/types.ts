import type { Feature, Polygon, MultiPolygon } from "geojson";

export type ZoneKind = "permanent" | "temporary";

export type ZoneCategory =
  | "airport"
  | "country-park"
  | "military"
  | "vip"
  | "event"
  | "custom";

export interface ZoneProperties {
  id: string;
  name: string;
  kind: ZoneKind;
  category: ZoneCategory;
  /** ISO timestamp for temporary zones. */
  expiresAt?: string;
  /** Max altitude (m AGL). undefined = total ban. */
  ceilingM?: number;
  createdAt: string;
  notes?: string;
}

export type ZoneFeature = Feature<Polygon | MultiPolygon, ZoneProperties>;

export interface DroneFix {
  id: string;
  lat: number;
  lng: number;
  altM: number;
  bearingDeg?: number;
  speedMs?: number;
  /** ms since epoch */
  t: number;
  registered?: boolean;
  category?: "A" | "B" | "C" | "unknown";
}

export type AlertStatus = "new" | "ack" | "resolved";

export interface TrackPoint {
  lat: number;
  lon: number;
  altM: number;
  /** ms since epoch */
  t: number;
}

export interface Track {
  id: number;
  status: "active" | "lost";
  /** ISO-8601 UTC */
  firstSeen: string;
  /** ISO-8601 UTC */
  lastSeen: string;
  lastLat: number;
  lastLon: number;
  lastAltM: number;
  pointCount: number;
  trail: TrackPoint[];
}

export interface Alert {
  id: string;
  droneId: string;
  zoneId: string;
  /** ms since epoch — first time this (drone, zone) pair entered. */
  t: number;
  /** ms since epoch — most recent detection refresh. Drives TTL pruning so
   * a drone that re-enters the same zone bumps lastSeen instead of spawning
   * a new alert row. */
  lastSeen: number;
  status: AlertStatus;
  severity: "low" | "medium" | "high";
  message: string;
  /** WGS-84 — where the detection occurred. Needed for map dot rendering. */
  lng: number;
  lat: number;
}
