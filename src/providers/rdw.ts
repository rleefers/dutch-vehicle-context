/**
 * De enige bron: het Nederlandse kentekenregister, als open data via Socrata.
 *
 * Negen datasets, waarvan er zeven direct op kenteken te bevragen zijn en twee codetabellen
 * die nodig zijn om de codes uit de eerste zeven leesbaar te maken. Alles CC0, geen sleutel.
 *
 * De terugroepketen is de reden dat deze laag bestaat. Het basisregister zegt over een
 * openstaande actie niet meer dan `Ja`. Om te weten wélke actie, wat er stuk kan, hoe
 * gevaarlijk dat is en wat de reparatie is, moet je van kenteken naar referentiecode
 * (`t49b-isb7`), naar de actiebeschrijving (`j9yg-7rg9`), naar de gevarenlijst
 * (`9ihi-jgpf`). Drie sprongen, en pas dan staat er iets bruikbaars.
 *
 * Live geverifieerd op 2026-08-19 met kenteken 01THFD (BMW 3-serie, 2006). Dat voertuig
 * heeft twee acties: MGP180384 is afgehandeld, MGP240221 staat open en gaat over een
 * airbag-gasgenerator die bij een ongeval kan exploderen. Wie alleen de eerste rij pakt,
 * rapporteert de afgehandelde actie en mist de gevaarlijke. Vandaar dat hier álle acties
 * worden opgehaald en per stuk hun status dragen.
 */
import { Bron, BronStatus } from "../types";

const BASIS = "https://opendata.rdw.nl/resource";

/**
 * User-Agent met contactadres. De bijsluiter stelt fair use als voorwaarde; dan hoort de
 * bronhouder te kunnen zien wie er belt.
 */
const UA = "dutch-vehicle-context/0.1 (+https://thaly.nl)";

/** Per dataset: de Socrata-id en de neutrale naam die in provenance komt. */
export const DATASETS = {
  basis: { id: "m9d7-ebf2", naam: "Kentekenregister — voertuigen" },
  brandstof: { id: "8ys7-d773", naam: "Kentekenregister — brandstof en emissie" },
  keuringen: { id: "vkij-7mwc", naam: "Kentekenregister — keuringen" },
  gebreken: { id: "a34c-vvps", naam: "Kentekenregister — geconstateerde gebreken" },
  carrosserie: { id: "vezc-m2t6", naam: "Kentekenregister — carrosserie" },
  assen: { id: "3huj-srit", naam: "Kentekenregister — assen" },
  terugroepStatus: { id: "t49b-isb7", naam: "Terugroepregister — status per voertuig" },
  terugroepActie: { id: "j9yg-7rg9", naam: "Terugroepregister — actiebeschrijving" },
  terugroepRisico: { id: "9ihi-jgpf", naam: "Terugroepregister — mogelijk gevaar" },
  gebrekCodes: { id: "hx2c-gt7k", naam: "Codetabel — gebrekomschrijvingen" },
  tellerCodes: { id: "jqs4-4kvw", naam: "Codetabel — toelichting tellerstandoordeel" },
} as const;

export type DatasetSleutel = keyof typeof DATASETS;

export interface Ophaal<T> {
  rijen: T[];
  bron: Bron;
  duur_ms: number;
}

/**
 * Eén dataset bevragen.
 *
 * Faalt nooit hard. Een stukgelopen bron levert een lege rijenlijst plus een provenance-
 * regel met de reden, zodat het antwoord overeind blijft en de stilte zichtbaar is. Dat is
 * invariant: een bron die omvalt mag er niet uitzien als een bron die niets te melden had.
 */
export async function haal<T = Record<string, unknown>>(
  sleutel: DatasetSleutel,
  params: Record<string, string>,
  timeoutMs = 8000,
): Promise<Ophaal<T>> {
  const ds = DATASETS[sleutel];
  const qs = new URLSearchParams(params).toString();
  const url = `${BASIS}/${ds.id}.json?${qs}`;
  const begin = Date.now();

  const basisBron = {
    name: ds.naam,
    dataset: ds.id,
    endpoint: url,
    retrieved_at: new Date().toISOString(),
  };

  try {
    const r = await fetch(url, {
      headers: { "user-agent": UA, accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const duur_ms = Date.now() - begin;

    if (!r.ok) {
      return {
        rijen: [],
        duur_ms,
        bron: { ...basisBron, status: "error" as BronStatus, note: `HTTP ${r.status}` },
      };
    }
    const rijen = (await r.json()) as T[];
    return {
      rijen,
      duur_ms,
      bron: {
        ...basisBron,
        status: (rijen.length ? "ok" : "empty") as BronStatus,
        rows: rijen.length,
      },
    };
  } catch (e) {
    const duur_ms = Date.now() - begin;
    const afgebroken = e instanceof Error && e.name === "TimeoutError";
    return {
      rijen: [],
      duur_ms,
      bron: {
        ...basisBron,
        status: "unavailable" as BronStatus,
        note: afgebroken ? `geen antwoord binnen ${timeoutMs} ms` : "netwerkfout",
      },
    };
  }
}

/**
 * Normaliseer een kenteken tot de vorm waarin het register het bewaart.
 *
 * Mensen typen `01-TH-FD`, `01 th fd` of `01THFD`; Socrata kent alleen de laatste. Ook de
 * letter O en het cijfer 0 worden door elkaar gehaald, maar dat corrigeren we bewust níét:
 * dat zou van gokken een feit maken, en een kenteken dat niet bestaat hoort `found: false`
 * op te leveren in plaats van de gegevens van een ander voertuig.
 */
export function normaliseerKenteken(invoer: string): string {
  return invoer.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Zet een genormaliseerd kenteken terug in de leesbare vorm met streepjes.
 *
 * Nederlandse kentekens zijn zes tekens in groepen van twee of drie. De groepering volgt uit
 * het patroon van cijfers en letters (de "sidecode"). Alleen de patronen die daadwerkelijk
 * zijn uitgegeven staan hier; wat er niet in past krijgt `null` in plaats van een gokje,
 * want een verkeerd afgebroken kenteken ziet er net zo overtuigend uit als een goed.
 */
export function formatteerKenteken(k: string): string | null {
  if (k.length !== 6) return null;
  const C = "[0-9]", L = "[A-Z]";
  const patronen: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
    // XX-99-99 / 99-99-XX / 99-XX-99 (sidecode 1-3)
    [new RegExp(`^(${L}{2})(${C}{2})(${C}{2})$`), (m) => `${m[1]}-${m[2]}-${m[3]}`],
    [new RegExp(`^(${C}{2})(${C}{2})(${L}{2})$`), (m) => `${m[1]}-${m[2]}-${m[3]}`],
    [new RegExp(`^(${C}{2})(${L}{2})(${C}{2})$`), (m) => `${m[1]}-${m[2]}-${m[3]}`],
    // XX-99-XX / XX-XX-99 / 99-XX-XX (sidecode 4-6)
    [new RegExp(`^(${L}{2})(${C}{2})(${L}{2})$`), (m) => `${m[1]}-${m[2]}-${m[3]}`],
    [new RegExp(`^(${L}{2})(${L}{2})(${C}{2})$`), (m) => `${m[1]}-${m[2]}-${m[3]}`],
    [new RegExp(`^(${C}{2})(${L}{2})(${L}{2})$`), (m) => `${m[1]}-${m[2]}-${m[3]}`],
    // 99-XXX-9 / 9-XXX-99 (sidecode 7-8)
    [new RegExp(`^(${C}{2})(${L}{3})(${C})$`), (m) => `${m[1]}-${m[2]}-${m[3]}`],
    [new RegExp(`^(${C})(${L}{3})(${C}{2})$`), (m) => `${m[1]}-${m[2]}-${m[3]}`],
    // XX-999-X / X-999-XX (sidecode 9-10)
    [new RegExp(`^(${L}{2})(${C}{3})(${L})$`), (m) => `${m[1]}-${m[2]}-${m[3]}`],
    [new RegExp(`^(${L})(${C}{3})(${L}{2})$`), (m) => `${m[1]}-${m[2]}-${m[3]}`],
    // XXX-99-X / X-99-XXX (sidecode 11-12)
    [new RegExp(`^(${L}{3})(${C}{2})(${L})$`), (m) => `${m[1]}-${m[2]}-${m[3]}`],
    [new RegExp(`^(${L})(${C}{2})(${L}{3})$`), (m) => `${m[1]}-${m[2]}-${m[3]}`],
    // 9-XX-999 / 999-XX-9 (sidecode 13-14)
    [new RegExp(`^(${C})(${L}{2})(${C}{3})$`), (m) => `${m[1]}-${m[2]}-${m[3]}`],
    [new RegExp(`^(${C}{3})(${L}{2})(${C})$`), (m) => `${m[1]}-${m[2]}-${m[3]}`],
  ];
  for (const [re, fmt] of patronen) {
    const m = k.match(re);
    if (m) return fmt(m);
  }
  return null;
}

/** RDW schrijft datums als `20240402`. Naar ISO, of null bij iets onverwachts. */
export function isoDatum(rdw: unknown): string | null {
  const s = String(rdw ?? "").trim();
  if (!/^\d{8}$/.test(s)) return null;
  const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  // Een datum als 20241332 past op het patroon maar bestaat niet.
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

/** Getal of null. RDW levert getallen soms als string, soms als number. */
export function getal(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/**
 * RDW gebruikt "Ja"/"Nee" als tekst.
 *
 * Alles wat geen van beide is wordt `null` en niet `false`. "Geen verstrekking in Open Data"
 * komt in deze velden echt voor, en dat is niet hetzelfde als nee.
 */
export function jaNee(v: unknown): boolean | null {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "ja") return true;
  if (s === "nee") return false;
  return null;
}
