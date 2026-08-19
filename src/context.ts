/**
 * Bouwt de volledige voertuigcontext uit één kenteken.
 *
 * De vorm is bewust: eerst één call naar het basisregister (die bepaalt of het kenteken
 * bestaat), daarna alles wat overblijft in parallel. Sequentieel gemeten kost de hele
 * fan-out 3,2 s; parallel is het de traagste tak, 350-500 ms. Dat verschil is precies de
 * reden dat dit werk in een laag hoort en niet bij de agent.
 *
 * Workers staat zes gelijktijdige uitgaande verbindingen toe. De tweede golf telt er zes,
 * de terugroepketen komt daarna en alleen als er iets te halen valt. Dat past.
 */
import {
  Bron, Brandstof, Gebreken, GebrekPerKeuring, GebrekPost, Identiteit, Keuring,
  Statusvlaggen, Technisch, Tellerstand, Terugroep, Terugroepactie, VehicleContext,
} from "./types";
import {
  formatteerKenteken, getal, haal, isoDatum, jaNee, normaliseerKenteken,
} from "./providers/rdw";
import { bouwSignalen } from "./signals";

/** Duur per bron van de laatste opbouw, voor de telemetrie. Niet in het antwoord. */
export let laatsteBronDuren: Record<string, number> = {};

export class KentekenOngeldig extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "KentekenOngeldig";
  }
}

const DISCLAIMER =
  "Feiten uit het openbare kentekenregister. Geen taxatie, geen technische keuring en geen " +
  "aankoopadvies. Signalen stellen geen gebrek vast. Diefstal- en vermissingsstatus zijn " +
  "niet openbaar en staan hier dus niet in: dit rapport zegt daar niets over.";

function jarenSinds(iso: string | null): number | null {
  if (!iso) return null;
  const dagen = (Date.now() - Date.parse(iso)) / 86400000;
  return dagen < 0 ? null : Math.floor(dagen / 365.25);
}

export async function bouwContext(invoer: string): Promise<VehicleContext> {
  const plate = normaliseerKenteken(invoer);
  // Zes tekens is de Nederlandse kentekenlengte. Korter of langer is geen kenteken, en dan
  // is een nette foutmelding beter dan een leeg rapport dat op "bestaat niet" lijkt.
  if (plate.length !== 6) {
    throw new KentekenOngeldig(
      `'${invoer}' is geen Nederlands kenteken. Een kenteken heeft zes tekens, ` +
      `bijvoorbeeld 01-TH-FD of 01THFD.`,
    );
  }

  const duren: Record<string, number> = {};
  const provenance: Bron[] = [];
  const noteer = <T>(naam: string, o: { rijen: T[]; bron: Bron; duur_ms: number }) => {
    duren[naam] = o.duur_ms;
    provenance.push(o.bron);
    return o.rijen;
  };

  // ── Golf 1: bestaat dit kenteken? ────────────────────────────────────────────────────
  const basisOp = await haal<Record<string, unknown>>("basis", { kenteken: plate, $limit: "1" });
  duren.basis = basisOp.duur_ms;
  provenance.push(basisOp.bron);
  const b = basisOp.rijen[0];

  if (!b) {
    // Onderscheid dat ertoe doet: kenden we het kenteken niet, of was de bron stuk? Bij een
    // storing mag er nooit "bestaat niet" uit komen.
    const gevonden = basisOp.bron.status === "empty";
    const leeg = leegContext(invoer, plate, provenance, gevonden ? "not_found" : "unavailable");
    laatsteBronDuren = duren;
    return leeg;
  }

  const first_admission = isoDatum(b.datum_eerste_toelating);

  const identity: Identiteit = {
    plate_input: invoer,
    plate,
    plate_formatted: formatteerKenteken(plate),
    found: true,
    vehicle_type: (b.voertuigsoort as string) ?? null,
    make: (b.merk as string) ?? null,
    trade_name: (b.handelsbenaming as string) ?? null,
    first_admission,
    first_admission_nl: isoDatum(b.datum_eerste_tenaamstelling_in_nederland),
    registered_since: isoDatum(b.datum_tenaamstelling),
    age_years: jarenSinds(first_admission),
  };

  // ── Golf 2: alles wat op kenteken te bevragen is, tegelijk ───────────────────────────
  const [brandstofR, keuringenR, gebrekenR, carrosserieR, assenR, terugroepR] = await Promise.all([
    haal<Record<string, unknown>>("brandstof", { kenteken: plate, $limit: "5" }),
    haal<Record<string, unknown>>("keuringen", { kenteken: plate, $limit: "50" }),
    haal<Record<string, unknown>>("gebreken", { kenteken: plate, $limit: "200" }),
    haal<Record<string, unknown>>("carrosserie", { kenteken: plate, $limit: "3" }),
    haal<Record<string, unknown>>("assen", { kenteken: plate, $limit: "6" }),
    haal<Record<string, unknown>>("terugroepStatus", { kenteken: plate, $limit: "20" }),
  ]);
  const brandstofRijen = noteer("brandstof", brandstofR);
  const keuringRijen = noteer("keuringen", keuringenR);
  const gebrekRijen = noteer("gebreken", gebrekenR);
  const carrosserieRijen = noteer("carrosserie", carrosserieR);
  const assenRijen = noteer("assen", assenR);
  const terugroepRijen = noteer("terugroep", terugroepR);

  // ── Golf 3: codes vertalen en de terugroepketen aflopen ──────────────────────────────
  // Alleen de codes die dit voertuig écht heeft; de codetabel in z'n geheel ophalen zou
  // duizenden rijen zijn voor hooguit een handvol treffers.
  const gebrekCodes = [...new Set(gebrekRijen.map((r) => String(r.gebrek_identificatie ?? "")))]
    .filter(Boolean);
  const refs = [...new Set(terugroepRijen.map((r) => String(r.referentiecode_rdw ?? "")))]
    .filter(Boolean);
  const tellerOordeel = (b.tellerstandoordeel as string) ?? null;

  const [codeRijen, actieRijen, risicoRijen, tellerRijen] = await Promise.all([
    gebrekCodes.length
      ? haal<Record<string, unknown>>("gebrekCodes", {
          $where: inLijst("gebrek_identificatie", gebrekCodes), $limit: "200",
        })
      : leegOphaal("gebrekCodes"),
    refs.length
      ? haal<Record<string, unknown>>("terugroepActie", {
          $where: inLijst("referentiecode_rdw", refs), $limit: "20",
        })
      : leegOphaal("terugroepActie"),
    refs.length
      ? haal<Record<string, unknown>>("terugroepRisico", {
          $where: inLijst("referentiecode_rdw", refs), $limit: "60",
        })
      : leegOphaal("terugroepRisico"),
    tellerOordeel
      ? haal<Record<string, unknown>>("tellerCodes", { $limit: "20" })
      : leegOphaal("tellerCodes"),
  ]);
  const codes = noteer("gebrekCodes", codeRijen);
  const acties = noteer("terugroepActie", actieRijen);
  const risicos = noteer("terugroepRisico", risicoRijen);
  const tellerToelichting = noteer("tellerCodes", tellerRijen);

  laatsteBronDuren = duren;

  const context: VehicleContext = {
    identity,
    technical: bouwTechnisch(b, carrosserieRijen, assenRijen),
    fuel: bouwBrandstof(brandstofRijen),
    inspection: bouwKeuring(b, keuringRijen),
    defects: bouwGebreken(gebrekRijen, codes),
    odometer: bouwTellerstand(tellerOordeel, b, tellerToelichting),
    recalls: bouwTerugroep(b, terugroepRijen, acties, risicos),
    status_flags: bouwVlaggen(b),
    value: { catalogue_price_new_eur: getal(b.catalogusprijs) },
    signals: [],
    provenance,
    generated_at: new Date().toISOString(),
    disclaimer: DISCLAIMER,
  };
  context.signals = bouwSignalen(context);
  return context;
}

/** Socrata-`IN`-clausule. Codes zijn alfanumeriek uit onze eigen respons, dus veilig. */
function inLijst(veld: string, waarden: string[]): string {
  const schoon = waarden
    .map((w) => w.replace(/[^A-Za-z0-9_-]/g, ""))
    .filter(Boolean)
    .map((w) => `'${w}'`);
  return `${veld} in(${schoon.join(",")})`;
}

/** Een niet-uitgevoerde ophaalactie, zodat provenance klopt zonder een bron te bellen. */
function leegOphaal(naam: string) {
  return Promise.resolve({
    rijen: [] as Record<string, unknown>[],
    duur_ms: 0,
    bron: {
      name: `Codetabel/keten — ${naam}`,
      dataset: "-",
      retrieved_at: new Date().toISOString(),
      status: "empty" as const,
      note: "niet bevraagd: dit voertuig had geen codes om te vertalen",
      rows: 0,
    },
  });
}

function leegContext(
  invoer: string, plate: string, provenance: Bron[], reden: "not_found" | "unavailable",
): VehicleContext {
  return {
    identity: {
      plate_input: invoer, plate, plate_formatted: formatteerKenteken(plate), found: false,
      vehicle_type: null, make: null, trade_name: null, first_admission: null,
      first_admission_nl: null, registered_since: null, age_years: null,
    },
    technical: {
      body: null, doors: null, seats: null, mass_empty_kg: null, mass_max_kg: null,
      cylinders: null, displacement_cc: null, axles: null, colour: null, wheelbase_cm: null,
    },
    fuel: [],
    inspection: { expiry_date: null, days_until_expiry: null, status: "unknown", history: [] },
    defects: { registrations: 0, inspection_rounds: 0, by_inspection: [], recurring: [] },
    odometer: { judgement: null, explanation: null },
    recalls: { has_open_recall: null, actions: [] },
    status_flags: {
      insured: null, exported: null, taxi_history: null, awaiting_inspection: null, stolen: null,
    },
    value: { catalogue_price_new_eur: null },
    signals: [
      reden === "not_found"
        ? {
            code: "plate_not_found",
            severity: "high" as const,
            message: `Kenteken ${formatteerKenteken(plate) ?? plate} staat niet in het ` +
              `kentekenregister. Mogelijk is het verkeerd overgenomen, of is het voertuig ` +
              `geëxporteerd of gesloopt.`,
            recommendation: "Controleer het kenteken. Presenteer geen gegevens over dit " +
              "voertuig; die zijn er niet.",
          }
        : {
            code: "source_unavailable",
            severity: "high" as const,
            message: "Het kentekenregister was niet bereikbaar. Dit betekent NIET dat het " +
              "kenteken niet bestaat.",
            recommendation: "Probeer het later opnieuw.",
          },
    ],
    provenance,
    generated_at: new Date().toISOString(),
    disclaimer: DISCLAIMER,
  };
}

function bouwTechnisch(
  b: Record<string, unknown>,
  carrosserie: Record<string, unknown>[],
  assen: Record<string, unknown>[],
): Technisch {
  return {
    body: (carrosserie[0]?.carrosserie_type_omschrijving as string)
      ?? (carrosserie[0]?.type_carrosserie_europese_omschrijving as string) ?? null,
    doors: getal(b.aantal_deuren),
    seats: getal(b.aantal_zitplaatsen),
    mass_empty_kg: getal(b.massa_ledig_voertuig),
    mass_max_kg: getal(b.toegestane_maximum_massa_voertuig),
    cylinders: getal(b.aantal_cilinders),
    displacement_cc: getal(b.cilinderinhoud),
    axles: assen.length || getal(b.aantal_wielen),
    colour: (b.eerste_kleur as string) ?? null,
    wheelbase_cm: getal(b.wielbasis),
  };
}

function bouwBrandstof(rijen: Record<string, unknown>[]): Brandstof[] {
  return rijen.map((r) => ({
    type: (r.brandstof_omschrijving as string) ?? null,
    emission_class: (r.uitlaatemissieniveau as string) ?? null,
    co2_combined_gkm: getal(r.co2_uitstoot_gecombineerd),
    consumption_combined_l100km: getal(r.brandstofverbruik_gecombineerd),
    electric_range_km: getal(r.elektrisch_bereik),
  }));
}

function bouwKeuring(b: Record<string, unknown>, keuringen: Record<string, unknown>[]): Keuring {
  const expiry_date = isoDatum(b.vervaldatum_apk);
  const history = keuringen
    .map((k) => isoDatum(k.vervaldatum_keuring))
    .filter((d): d is string => !!d)
    .sort()
    .reverse();

  if (!expiry_date) return { expiry_date: null, days_until_expiry: null, status: "unknown", history };

  const dagen = Math.floor((Date.parse(expiry_date) - Date.now()) / 86400000);
  return {
    expiry_date,
    days_until_expiry: dagen,
    status: dagen < 0 ? "expired" : dagen <= 60 ? "expiring_soon" : "valid",
    history,
  };
}

function bouwGebreken(
  rijen: Record<string, unknown>[], codes: Record<string, unknown>[],
): Gebreken {
  // De codetabel heeft per code meerdere rijen met een geldigheidsperiode. Voor een
  // omschrijving maakt dat niet uit; de eerste volstaat.
  const omschrijving = new Map<string, string>();
  for (const c of codes) {
    const id = String(c.gebrek_identificatie ?? "");
    if (id && !omschrijving.has(id)) {
      omschrijving.set(id, String(c.gebrek_omschrijving ?? ""));
    }
  }

  const perDatum = new Map<string, Map<string, number>>();
  for (const r of rijen) {
    const datum = isoDatum(r.meld_datum_door_keuringsinstantie);
    const code = String(r.gebrek_identificatie ?? "");
    if (!datum || !code) continue;
    if (!perDatum.has(datum)) perDatum.set(datum, new Map());
    const m = perDatum.get(datum)!;
    m.set(code, (m.get(code) ?? 0) + (getal(r.aantal_gebreken_geconstateerd) ?? 1));
  }

  const by_inspection: GebrekPerKeuring[] = [...perDatum.entries()]
    .sort((a, z) => z[0].localeCompare(a[0]))
    .map(([date, m]) => ({
      date,
      items: [...m.entries()].map(([code, count]) => ({
        code, description: omschrijving.get(code) ?? null, count,
      })),
    }));

  // Terugkerend = dezelfde code in meer dan één keuringsRONDE. Niet: op meer dan één datum.
  //
  // Dat onderscheid is de hele crux, en de eerste versie had het fout. Een afgekeurd voertuig
  // wordt hersteld en opnieuw aangeboden, en die herkeuring krijgt een eigen datum. Bij het
  // testvoertuig 01THFD stonden 2026-05-11 en 2026-05-15 apart, en 2024-04-02 en 2024-04-10
  // ook. Op datum tellen maakte daarvan "remslang beschadigd komt bij 2 keuringen terug",
  // terwijl het één afkeuring met één herkeuring was. Dat is precies het soort
  // plausibel-maar-onwaar signaal waar deze laag tegen hoort te beschermen.
  //
  // Datums binnen 60 dagen van elkaar horen daarom bij dezelfde ronde. Een herkeuring moet
  // in Nederland binnen twee maanden; daarbuiten is het een nieuwe keuringscyclus.
  const HERKEURING_VENSTER_DAGEN = 60;
  const datums = by_inspection.map((k) => k.date); // al aflopend gesorteerd
  const rondeVan = new Map<string, string>();
  let huidigeRonde = datums[0];
  for (const d of datums) {
    const verschil = (Date.parse(huidigeRonde) - Date.parse(d)) / 86400000;
    if (verschil > HERKEURING_VENSTER_DAGEN) huidigeRonde = d;
    rondeVan.set(d, huidigeRonde);
  }

  const rondesPerCode = new Map<string, Set<string>>();
  for (const k of by_inspection) {
    for (const i of k.items) {
      if (!rondesPerCode.has(i.code)) rondesPerCode.set(i.code, new Set());
      rondesPerCode.get(i.code)!.add(rondeVan.get(k.date)!);
    }
  }
  const recurring: GebrekPost[] = [...rondesPerCode.entries()]
    .filter(([, r]) => r.size > 1)
    .map(([code, r]) => ({ code, description: omschrijving.get(code) ?? null, count: r.size }))
    .sort((a, z) => z.count - a.count);

  return {
    registrations: rijen.length,
    inspection_rounds: new Set(rondeVan.values()).size,
    by_inspection,
    recurring,
  };
}

function bouwTellerstand(
  oordeel: string | null, b: Record<string, unknown>, toelichting: Record<string, unknown>[],
): Tellerstand {
  const code = String(b.code_toelichting_tellerstandoordeel ?? "").padStart(2, "0");
  const rij = toelichting.find(
    (t) => String(t.code_toelichting_tellerstandoordeel ?? "") === code,
  );
  return {
    judgement: oordeel,
    explanation: (rij?.toelichting_tellerstandoordeel as string) ?? null,
  };
}

function bouwTerugroep(
  b: Record<string, unknown>,
  statusRijen: Record<string, unknown>[],
  acties: Record<string, unknown>[],
  risicos: Record<string, unknown>[],
): Terugroep {
  const actieOp = new Map(acties.map((a) => [String(a.referentiecode_rdw ?? ""), a]));
  const gevarenOp = new Map<string, string[]>();
  for (const r of risicos) {
    const ref = String(r.referentiecode_rdw ?? "");
    const gevaar = String(r.mogelijk_gevaar ?? "").trim();
    if (!ref || !gevaar) continue;
    if (!gevarenOp.has(ref)) gevarenOp.set(ref, []);
    gevarenOp.get(ref)!.push(gevaar);
  }

  const actions: Terugroepactie[] = statusRijen.map((s) => {
    const ref = String(s.referentiecode_rdw ?? "");
    const a = actieOp.get(ref) ?? {};
    return {
      reference: ref,
      status: String(s.status ?? "onbekend"),
      // Code "O" is de openstaande actie. Op de statustekst matchen zou breken zodra de
      // RDW die herformuleert.
      open: String(s.code_status ?? "").toUpperCase() === "O",
      defect: (a.omschrijving_defect as string) ?? null,
      consequence: (a.materi_le_gevolgen as string) ?? null,
      repair: (a.beschrijving_van_het_herstel as string) ?? null,
      hazards: gevarenOp.get(ref) ?? [],
      published: isoDatum(a.publicatiedatum_rdw),
      manufacturer: (a.meldende_producent_distributeur as string) ?? null,
      vehicles_in_action: getal(a.totaal_aantal_voertuigen_terugroepactie),
      more_info_url: (a.meer_informatie_op_internet as string) ?? null,
    };
  })
    // Openstaande acties eerst: dat is wat een koper moet zien.
    .sort((x, z) => Number(z.open) - Number(x.open));

  return { has_open_recall: jaNee(b.openstaande_terugroepactie_indicator), actions };
}

function bouwVlaggen(b: Record<string, unknown>): Statusvlaggen {
  const wok = String(b.wacht_op_keuren ?? "").trim();
  return {
    insured: jaNee(b.wam_verzekerd),
    exported: jaNee(b.export_indicator),
    taxi_history: jaNee(b.taxi_indicator),
    // Dit veld bevat vaak letterlijk "Geen verstrekking in Open Data". Dat is geen "nee",
    // dus het gaat als tekst mee en wordt niet tot een boolean geplet.
    awaiting_inspection: wok || null,
    stolen: null,
  };
}
