/**
 * Regressietest tegen de live dienst.
 *
 * Bestaat vanaf dag één, omdat het zusterproject leerde dat juist de koppelingen stilletjes
 * fout gaan: daar publiceerden we maandenlang een monumentnummer dat naar een heel ander pand
 * wees, en dat overleefde elke deploy, elke typecheck en een agent-test met tien prompts.
 *
 * Hier is die les meteen bevestigd. De eerste versie van `recurring_defect` telde
 * keuringsDATUMS in plaats van keuringsRONDES, en meldde daardoor "remslang beschadigd komt
 * terug" terwijl het één afkeuring met een herkeuring acht dagen later was. Case 3 hieronder
 * bewaakt precies dat.
 *
 * Elke verwachting is met de hand geverifieerd tegen de bron.
 *
 * Draaien:  node regression.mjs [basis-url]
 * Exit 0 = alles goed, 1 = minstens één afwijking.
 */
const BASIS = process.argv[2] ?? "https://dutch-vehicle-context.thaly.workers.dev";

const CASES = [
  {
    naam: "01THFD — BMW met openstaande airbag-recall, onlogische teller, terugkerende gebreken",
    plate: "01THFD",
    verwacht: {
      "identity.found": true,
      "identity.make": "BMW",
      "identity.plate_formatted": "01-TH-FD",
      "identity.first_admission": "2006-10-02",
      "odometer.judgement": "Onlogisch",
      "recalls.has_open_recall": true,
    },
    controles: [
      ["precies één openstaande terugroepactie", (d) =>
        d.recalls.actions.filter((a) => a.open).length === 1],
      ["de openstaande actie is MGP240221, niet de afgehandelde MGP180384", (d) =>
        d.recalls.actions.find((a) => a.open)?.reference === "MGP240221"],
      ["die actie draagt zijn gevaaromschrijving", (d) =>
        (d.recalls.actions.find((a) => a.open)?.hazards ?? []).length > 0],
      ["signaal open_recall aanwezig en high", (d) =>
        d.signals.some((s) => s.code === "open_recall" && s.severity === "high")],
      ["signaal odometer_illogical aanwezig", (d) =>
        d.signals.some((s) => s.code === "odometer_illogical")],
      ["gebrekcodes zijn vertaald naar tekst", (d) =>
        d.defects.by_inspection[0]?.items.every((i) => typeof i.description === "string")],
    ],
  },
  {
    naam: "01THFD — herkeuring telt niet als terugkerend gebrek",
    plate: "01-th-fd",
    verwacht: {
      // Vijf keuringsdatums, maar drie rondes: 2026-05-11/15 en 2024-04-02/10 horen bij elkaar.
      "defects.inspection_rounds": 3,
    },
    controles: [
      ["code 307 staat NIET in recurring (was één ronde, afkeuring + herkeuring)", (d) =>
        !d.defects.recurring.some((r) => r.code === "307")],
      ["code AC4 staat WEL in recurring (drie verschillende jaren)", (d) =>
        d.defects.recurring.some((r) => r.code === "AC4" && r.count === 3)],
      ["er zijn meer keuringsdatums dan rondes", (d) =>
        d.defects.by_inspection.length > d.defects.inspection_rounds],
    ],
  },
  {
    naam: "XN006N — schone auto: geen valse alarmen",
    plate: "XN006N",
    verwacht: {
      "identity.found": true,
      "identity.make": "VOLVO",
      "odometer.judgement": "Logisch",
      "recalls.has_open_recall": false,
    },
    controles: [
      ["geen open_recall-signaal", (d) => !d.signals.some((s) => s.code === "open_recall")],
      ["geen odometer-signaal bij oordeel Logisch", (d) =>
        !d.signals.some((s) => s.code.startsWith("odometer_"))],
      ["geen recurring_defect", (d) => !d.signals.some((s) => s.code === "recurring_defect")],
    ],
  },
  {
    naam: "Diefstalstatus wordt ALTIJD als onbekend gemeld, ook bij een schone auto",
    plate: "XN006N",
    verwacht: { "status_flags.stolen": null },
    controles: [
      ["signaal theft_status_not_published aanwezig", (d) =>
        d.signals.some((s) => s.code === "theft_status_not_published")],
      ["de disclaimer noemt het ook", (d) => /gestolen|diefstal/i.test(d.disclaimer)],
    ],
  },
  {
    naam: "Onbekend kenteken — found=false, geen verzonnen velden",
    plate: "ZZ999Z",
    verwacht: { "identity.found": false, "identity.make": null },
    controles: [
      ["signaal plate_not_found", (d) => d.signals.some((s) => s.code === "plate_not_found")],
      ["geen enkel signaal doet alsof er een voertuig is", (d) =>
        !d.signals.some((s) => ["open_recall", "apk_expired"].includes(s.code))],
    ],
  },
  {
    naam: "Te kort kenteken — nette 400, geen leeg rapport",
    plate: "ABC",
    verwachtHttp: 400,
  },
  {
    naam: "Kenteken met streepjes en kleine letters normaliseert",
    plate: "xn-00-6n",
    verwacht: { "identity.found": true, "identity.plate": "XN006N", "identity.make": "VOLVO" },
  },
  {
    naam: "compact laat de keuringshistorie in, maar houdt alle signalen",
    plate: "01THFD",
    depth: "compact",
    controles: [
      ["hoogstens één keuring in compact", (d) => d.defects.by_inspection.length <= 1],
      ["signalen blijven volledig", (d) => d.signals.length >= 4],
      ["openstaande recall blijft volledig beschreven", (d) =>
        typeof d.recalls.actions.find((a) => a.open)?.defect === "string"],
      ["afgehandelde recall is ingekort", (d) =>
        d.recalls.actions.filter((a) => !a.open).every((a) => a.defect === undefined)],
    ],
  },
];

function pad(obj, uitdrukking) {
  return uitdrukking.split(".").reduce((o, deel) => {
    if (o === undefined || o === null) return undefined;
    const m = deel.match(/^(\w+)\[(\d+)\]$/);
    if (m) return o[m[1]]?.[Number(m[2])];
    return o[deel];
  }, obj);
}

let mislukt = 0;
for (const c of CASES) {
  const q = new URLSearchParams({ plate: c.plate, refresh: "1" });
  if (c.depth) q.set("depth", c.depth);
  else q.set("depth", "full");
  const url = `${BASIS}/v1/vehicle/context?${q}`;

  let data, http;
  try {
    const r = await fetch(url);
    http = r.status;
    data = await r.json();
  } catch (e) {
    console.log(`✗ ${c.naam}\n    ophalen mislukt: ${e.message}`);
    mislukt++;
    continue;
  }

  const fouten = [];

  if (c.verwachtHttp) {
    if (http !== c.verwachtHttp) fouten.push(`HTTP: verwacht ${c.verwachtHttp}, kreeg ${http}`);
  } else if (http !== 200) {
    fouten.push(`HTTP ${http}: ${JSON.stringify(data).slice(0, 140)}`);
  }

  for (const [sleutel, verwacht] of Object.entries(c.verwacht ?? {})) {
    const gekregen = pad(data, sleutel);
    if (gekregen !== verwacht) {
      fouten.push(`${sleutel}: verwacht ${JSON.stringify(verwacht)}, kreeg ${JSON.stringify(gekregen)}`);
    }
  }
  for (const [omschrijving, fn] of c.controles ?? []) {
    let ok = false;
    try { ok = fn(data); } catch (e) { fouten.push(`${omschrijving}: wierp ${e.message}`); continue; }
    if (!ok) fouten.push(`niet waar: ${omschrijving}`);
  }

  if (fouten.length) {
    console.log(`✗ ${c.naam}`);
    for (const f of fouten) console.log(`    ${f}`);
    mislukt++;
  } else {
    console.log(`✓ ${c.naam}`);
  }
  // De rate limiter staat op 10 per 10 s; rustig aan zodat de test zichzelf niet velt.
  await new Promise((r) => setTimeout(r, 1200));
}

console.log(`\n${CASES.length - mislukt}/${CASES.length} geslaagd`);
process.exit(mislukt ? 1 : 0);
