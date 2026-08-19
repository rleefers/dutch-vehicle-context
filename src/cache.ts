/**
 * Gedeelde cache rond `bouwContext`, voor zowel HTTP als MCP.
 *
 * Bij het zusterproject bestond deze laag eerst alleen in het HTTP-pad, waardoor MCP — het
 * kanaal waar het product voor bestaat — elke keer koud opbouwde en alle bronnen opnieuw
 * belastte. Die fout is hier vermeden door de cache vanaf het begin voor beide ingangen te
 * schrijven.
 */
import { bouwContext } from "./context";
import { VehicleContext } from "./types";

/**
 * Vorm van de response. Ophogen zodra er een veld bij komt of verdwijnt.
 *
 * Zit in de cachesleutel omdat een deploy anders tot een uur lang antwoorden in het oude
 * formaat blijft serveren.
 */
export const SCHEMA = "v1";

export type CacheStatus = "hit" | "miss" | "bypass";

export interface ContextResultaat {
  context: VehicleContext;
  cache: CacheStatus;
  duur_ms: number;
}

export async function haalContext(
  plate: string,
  waitUntil: (p: Promise<unknown>) => void,
  opties: { refresh?: boolean; ttlSeconden?: number } = {},
): Promise<ContextResultaat> {
  const { refresh = false, ttlSeconden = 3600 } = opties;
  const begin = Date.now();

  // Sleutel op het genormaliseerde kenteken, zodat 01-TH-FD en 01thfd dezelfde hit geven.
  const sleutel = new Request(
    `https://cache.dutch-vehicle-context/${SCHEMA}/` +
      encodeURIComponent(plate.toUpperCase().replace(/[^A-Z0-9]/g, "")),
    { method: "GET" },
  );
  const cache = caches.default;

  if (!refresh) {
    const hit = await cache.match(sleutel);
    if (hit) {
      return {
        context: (await hit.json()) as VehicleContext,
        cache: "hit",
        duur_ms: Date.now() - begin,
      };
    }
  }

  const context = await bouwContext(plate);

  // Een mislukte ophaling niet een uur lang vasthouden: dan blijft een storing hangen nadat
  // de bron alweer terug is.
  const heeftStoring = context.provenance.some(
    (b) => b.status === "unavailable" || b.status === "error",
  );
  const ttl = heeftStoring ? 60 : ttlSeconden;

  waitUntil(
    cache.put(
      sleutel,
      new Response(JSON.stringify(context), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": `public, max-age=${ttl}`,
        },
      }),
    ),
  );

  return { context, cache: refresh ? "bypass" : "miss", duur_ms: Date.now() - begin };
}
