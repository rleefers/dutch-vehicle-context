/**
 * Eén JSON-regel per verzoek naar Workers Logs.
 *
 * Privacy: **geen kenteken, geen IP**. Een kenteken is een persoonsgegeven zodra het aan
 * iemand te koppelen is, en een logbestand met kentekens plus tijdstippen is precies zo'n
 * koppeling. Wat hier wél in gaat is merk en bouwjaar — genoeg om te zien welke voertuigen
 * worden opgevraagd, te weinig om er iemand mee te vinden.
 */
import { VehicleContext } from "./types";
import { CacheStatus } from "./cache";
import { Depth } from "./shape";

export interface TelemetrieExtra {
  transport: "http" | "mcp";
  depth: Depth;
  cache: CacheStatus;
  duur_ms: number;
  bytes: number;
  bron_ms?: Record<string, number>;
}

export function logTelemetrie(c: VehicleContext, x: TelemetrieExtra): void {
  console.log(JSON.stringify({
    evt: "vehicle_context",
    transport: x.transport,
    depth: x.depth,
    cache: x.cache,
    duur_ms: x.duur_ms,
    bytes: x.bytes,
    found: c.identity.found,
    // Grofmazig genoeg om niet naar één voertuig te wijzen.
    make: c.identity.make,
    year: c.identity.first_admission?.slice(0, 4) ?? null,
    vehicle_type: c.identity.vehicle_type,
    signals: c.signals.map((s) => s.code),
    open_recalls: c.recalls.actions.filter((a) => a.open).length,
    sources: Object.fromEntries(c.provenance.map((b) => [b.dataset, b.status])),
    bron_ms: x.bron_ms,
  }));
}
