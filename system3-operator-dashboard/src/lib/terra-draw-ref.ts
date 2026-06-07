"use client";

import type { MaplibreTerradrawControl } from "@watergis/maplibre-gl-terradraw";

/**
 * Module-level ref to the live TerraDraw control. The map canvas registers
 * the instance once on map-load; sidebar buttons read it at click time to
 * call `td.setMode("polygon" | "rectangle" | "circle" | "select")`.
 *
 * Lives outside React/Zustand on purpose — sidebar interactions are one-shot
 * commands, not reactive state, so we'd just be paying for a re-render with
 * no benefit. Single-instance singleton — there's only ever one map.
 */
let instance: MaplibreTerradrawControl | null = null;

export const setTerraDrawRef = (td: MaplibreTerradrawControl | null) => {
  instance = td;
};

export const getTerraDrawRef = (): MaplibreTerradrawControl | null => instance;
