/**
 * Twee detailniveaus, met `compact` als standaard.
 *
 * Overgenomen uit het zusterproject, waar meten uitwees dat bron-URL's en lange lijsten het
 * leeuwendeel van de payload waren terwijl negen van de tien vragen aan een fractie genoeg
 * hadden. Hier is dezelfde afweging vooraf gemaakt in plaats van achteraf: de
 * terugroepbeschrijvingen zijn lange lappen fabrikantentekst en de gebrekhistorie kan
 * tientallen keuringen beslaan.
 *
 * Twee dingen blijven altijd staan, in beide niveaus:
 *   1. Alle signalen. Dat is de laag die verkeerd lezen voorkomt.
 *   2. De bronvermelding per bron, met status. Niet vanwege een licentieplicht — CC0 kent
 *      die niet — maar omdat een antwoord zonder herkomst niet te controleren is.
 */
import { VehicleContext } from "./types";

export type Depth = "compact" | "full";

export function parseDepth(v: string | null): Depth {
  return v === "full" ? "full" : "compact";
}

export function vormAntwoord(c: VehicleContext, depth: Depth): unknown {
  if (depth === "full") return c;

  return {
    ...c,
    defects: {
      ...c.defects,
      // Alleen de laatste keuring; de rest is historie die zelden gelezen wordt. Het aantal
      // registraties en de terugkerende gebreken blijven, want dat zijn de conclusies.
      by_inspection: c.defects.by_inspection.slice(0, 1),
      omitted_inspections: Math.max(0, c.defects.by_inspection.length - 1),
    },
    recalls: {
      ...c.recalls,
      actions: c.recalls.actions.map((a) =>
        a.open
          // Een openstaande actie blijft volledig: dat is het belangrijkste in het rapport.
          ? a
          // Een afgehandelde actie wordt teruggebracht tot het feit dát hij er was.
          : { reference: a.reference, status: a.status, open: false, published: a.published },
      ),
    },
    provenance: c.provenance.map((b) => ({
      name: b.name,
      dataset: b.dataset,
      status: b.status,
      rows: b.rows,
      ...(b.note ? { note: b.note } : {}),
    })),
  };
}
