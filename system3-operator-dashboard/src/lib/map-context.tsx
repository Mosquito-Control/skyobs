"use client";

import { createContext, useContext } from "react";
import type maplibregl from "maplibre-gl";
import type { MaplibreTerradrawControl } from "@watergis/maplibre-gl-terradraw";

/**
 * MapContext exposes the live MapLibre `Map` instance to overlay components.
 *
 * The provider in `map-canvas.tsx` only publishes a non-null value once the
 * map's `load` event has fired — so any consumer can safely call
 * `map.addSource` / `map.addLayer` without worrying about an unloaded style.
 *
 * Consumers should treat `null` as "map not ready yet" and skip work.
 */
export const MapContext = createContext<maplibregl.Map | null>(null);

export const useMapInstance = (): maplibregl.Map | null => useContext(MapContext);

/** TerraDraw control instance, published once the map has loaded. */
export const TerraDrawContext =
  createContext<MaplibreTerradrawControl | null>(null);

export const useTerraDraw = (): MaplibreTerradrawControl | null =>
  useContext(TerraDrawContext);
