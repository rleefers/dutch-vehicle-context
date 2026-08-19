/**
 * Signalen: de laag die van losse velden een oordeel maakt zonder een gebrek vast te stellen.
 *
 * Een signaal is geen feit over het voertuig maar een observatie over de gegevens. "Deze
 * auto is onveilig" zeggen we nooit; "er staat een terugroepactie open waarbij de fabrikant
 * schrijft dat de gasgenerator kan exploderen" wel, want dat staat er letterlijk.
 *
 * Twee soorten signalen verdienen aparte aandacht, en samen zijn ze de kern van dit product:
 *
 * 1. **Signalen uit een koppeling.** `recurring_defect` bestaat in geen enkele dataset. Hij
 *    ontstaat door gebrekregistraties op datum te groeperen en te kijken welke code twee
 *    keer voorkomt. Dat is het verschil tussen "ooit afgekeurd" en "niet gerepareerd".
 *
 * 2. **Signalen over wat we níét weten.** `theft_status_not_published` staat er altijd in,
 *    ook — juist — als de rest van het rapport schoon is. Zonder dat signaal leest een
 *    volledig rapport zonder diefstalvermelding als "niet gestolen", en dat is de
 *    gevaarlijkste conclusie die iemand uit deze data kan trekken.
 */
import { Signaal, VehicleContext } from "./types";

/** Onder deze EURO-klassen gelden in Nederlandse milieuzones beperkingen voor diesel. */
const MILIEUZONE_DIESEL_ONDERGRENS = 5;

export function bouwSignalen(c: VehicleContext): Signaal[] {
  const s: Signaal[] = [];
  if (!c.identity.found) return s; // de lege context draagt zijn eigen signaal al

  terugroep(c, s);
  tellerstand(c, s);
  keuring(c, s);
  gebreken(c, s);
  vlaggen(c, s);
  milieu(c, s);
  herkomst(c, s);
  bronnen(c, s);
  diefstalOnbekend(s);

  // Ernstigste eerst: een agent die alleen het begin leest, moet het belangrijkste hebben.
  const rang = { high: 0, attention: 1, info: 2 };
  return s.sort((a, z) => rang[a.severity] - rang[z.severity]);
}

function terugroep(c: VehicleContext, s: Signaal[]): void {
  const open = c.recalls.actions.filter((a) => a.open);
  const afgehandeld = c.recalls.actions.filter((a) => !a.open);

  for (const a of open) {
    const gevaar = a.hazards.length ? ` Mogelijk gevaar volgens het register: ${a.hazards.join("; ")}.` : "";
    s.push({
      code: "open_recall",
      severity: "high",
      message:
        `Er staat een terugroepactie open (${a.reference}` +
        `${a.published ? `, gepubliceerd ${a.published}` : ""}).` +
        (a.defect ? ` ${a.defect}` : "") +
        (a.consequence ? ` ${a.consequence}` : "") +
        gevaar,
      recommendation: a.repair
        ? `Nog niet uitgevoerd. ${a.repair}`
        : "Laat de fabrikant of een merkdealer de actie alsnog uitvoeren; dat is kosteloos.",
      based_on: {
        reference: a.reference,
        status: a.status,
        vehicles_in_action: a.vehicles_in_action,
        more_info: a.more_info_url,
      },
    });
  }

  // Het vlaggetje uit het basisregister en de actielijst kunnen elkaar tegenspreken. Dan
  // niet kiezen, maar beide tonen — hetzelfde principe als conflicterende bouwjaren bij het
  // zusterproject.
  if (c.recalls.has_open_recall === true && open.length === 0) {
    s.push({
      code: "recall_status_conflict",
      severity: "attention",
      message:
        "Het basisregister meldt een openstaande terugroepactie, maar in het terugroepregister " +
        "staat voor dit kenteken geen actie met status 'openstaand'. De registers spreken " +
        "elkaar tegen.",
      recommendation: "Laat een merkdealer op VIN controleren of er nog een actie openstaat.",
      based_on: { indicator: true, open_actions_found: 0, actions_total: c.recalls.actions.length },
    });
  }

  if (afgehandeld.length && open.length === 0) {
    s.push({
      code: "recall_resolved",
      severity: "info",
      message:
        `${afgehandeld.length} eerdere terugroepactie(s) op dit voertuig zijn volgens het ` +
        `register afgehandeld.`,
      based_on: { references: afgehandeld.map((a) => a.reference) },
    });
  }
}

function tellerstand(c: VehicleContext, s: Signaal[]): void {
  const o = (c.odometer.judgement ?? "").toLowerCase();
  if (!o) return;

  if (o.includes("onlogisch")) {
    s.push({
      code: "odometer_illogical",
      severity: "high",
      message:
        "Het register beoordeelt de kilometerstand als onlogisch: een geregistreerde stand " +
        "was lager dan een eerdere." +
        (c.odometer.explanation ? ` ${c.odometer.explanation}` : ""),
      recommendation:
        "Vraag de volledige onderhoudshistorie op en laat de tellerstand controleren. Een " +
        "onlogische stand kan op terugdraaien wijzen, maar ook op een vervangen teller.",
      based_on: { judgement: c.odometer.judgement },
    });
    return;
  }

  // "Geen oordeel" en "Niet geregistreerd" zijn géén goedkeuring. Zonder dit signaal leest
  // de afwezigheid van "onlogisch" als "in orde".
  if (o.includes("geen oordeel") || o.includes("niet geregistreerd")) {
    s.push({
      code: "odometer_no_judgement",
      severity: "attention",
      message:
        `Over de kilometerstand is geen oordeel beschikbaar (${c.odometer.judgement}). Dat is ` +
        `iets anders dan een goedkeuring: het register heeft te weinig registraties om iets ` +
        `te kunnen zeggen.` + (c.odometer.explanation ? ` ${c.odometer.explanation}` : ""),
      recommendation: "Leid hier niets uit af. Controleer de stand tegen de onderhoudshistorie.",
      based_on: { judgement: c.odometer.judgement },
    });
  }
}

function keuring(c: VehicleContext, s: Signaal[]): void {
  const k = c.inspection;
  if (k.status === "expired") {
    s.push({
      code: "apk_expired",
      severity: "high",
      message: `De APK is verlopen op ${k.expiry_date} (${Math.abs(k.days_until_expiry ?? 0)} ` +
        `dagen geleden). Met een verlopen APK mag het voertuig niet de weg op.`,
      recommendation: "Laat keuren voor je ermee rijdt; ook de verzekering kan hierop afwijzen.",
      based_on: { expiry_date: k.expiry_date },
    });
  } else if (k.status === "expiring_soon") {
    s.push({
      code: "apk_expiring_soon",
      severity: "attention",
      message: `De APK verloopt over ${k.days_until_expiry} dagen, op ${k.expiry_date}.`,
      recommendation: "Reken de keuring en eventuele reparaties mee in de prijs.",
      based_on: { expiry_date: k.expiry_date },
    });
  } else if (k.status === "unknown") {
    s.push({
      code: "apk_unknown",
      severity: "attention",
      message: "Er staat geen APK-vervaldatum geregistreerd. Voor sommige voertuigsoorten " +
        "geldt geen keuringsplicht; bij een personenauto is dit ongebruikelijk.",
      based_on: { vehicle_type: c.identity.vehicle_type },
    });
  }
}

function gebreken(c: VehicleContext, s: Signaal[]): void {
  const d = c.defects;
  if (!d.by_inspection.length) return;

  if (d.recurring.length) {
    const lijst = d.recurring
      .map((r) => `${r.description ?? r.code} (bij ${r.count} keuringen)`)
      .join("; ");
    s.push({
      code: "recurring_defect",
      severity: "high",
      message:
        `Dezelfde afkeurpunten komen bij meerdere keuringen terug: ${lijst}. Dat wijst erop ` +
        `dat een eerder geconstateerd gebrek niet blijvend is verholpen.`,
      recommendation: "Vraag de facturen van de reparaties op en laat deze punten gericht nakijken.",
      based_on: { codes: d.recurring.map((r) => r.code) },
    });
  }

  const laatste = d.by_inspection[0];
  const totaal = laatste.items.reduce((n, i) => n + i.count, 0);
  s.push({
    code: "defects_at_last_inspection",
    severity: totaal >= 3 ? "attention" : "info",
    message:
      `Bij de laatste geregistreerde keuring (${laatste.date}) zijn ${totaal} gebrek(en) ` +
      `genoteerd: ${laatste.items.map((i) => i.description ?? i.code).join("; ")}.`,
    recommendation:
      "Een geconstateerd gebrek is bij goedkeuring hersteld; het zegt wel iets over de staat " +
      "van onderhoud.",
    based_on: { date: laatste.date, codes: laatste.items.map((i) => i.code) },
  });
}

function vlaggen(c: VehicleContext, s: Signaal[]): void {
  const f = c.status_flags;

  if (f.insured === false) {
    s.push({
      code: "not_insured",
      severity: "attention",
      message: "Er staat geen geldige WA-verzekering geregistreerd. Voor een voertuig met " +
        "kenteken is die wettelijk verplicht, tenzij het is geschorst.",
      recommendation: "Vraag na of het voertuig geschorst is.",
    });
  }
  if (f.exported === true) {
    s.push({
      code: "exported",
      severity: "high",
      message: "Het voertuig staat geregistreerd als geëxporteerd. Het is dan niet langer " +
        "in Nederland toegelaten en de gegevens hierboven worden niet meer bijgewerkt.",
      recommendation: "Controleer waar het voertuig nu geregistreerd staat.",
    });
  }
  if (f.taxi_history === true) {
    s.push({
      code: "taxi_history",
      severity: "attention",
      message: "Het voertuig is als taxi geregistreerd (geweest). Taxi's maken doorgaans veel " +
        "meer kilometers en meer korte ritten dan een particuliere auto.",
      recommendation: "Weeg dit mee bij de kilometerstand en de verwachte slijtage.",
    });
  }
  // "Geen verstrekking in Open Data" is de normale waarde; alleen iets anders is nieuws.
  const wok = f.awaiting_inspection;
  if (wok && !/geen verstrekking/i.test(wok)) {
    s.push({
      code: "awaiting_inspection",
      severity: "high",
      message: `Het register meldt een status 'wacht op keuren': ${wok}. Er mag dan niet mee ` +
        `worden gereden tot het voertuig is goedgekeurd.`,
      recommendation: "Zoek uit waarom deze status is gezet voor je iets afspreekt.",
    });
  }
}

function milieu(c: VehicleContext, s: Signaal[]): void {
  for (const b of c.fuel) {
    const soort = (b.type ?? "").toLowerCase();
    const euro = getEuroKlasse(b.emission_class);
    if (soort.includes("diesel") && euro !== null && euro < MILIEUZONE_DIESEL_ONDERGRENS) {
      s.push({
        code: "emission_zone_restricted",
        severity: "attention",
        message:
          `Diesel met emissieklasse ${b.emission_class}. Nederlandse milieuzones weren ` +
          `doorgaans diesels onder EURO ${MILIEUZONE_DIESEL_ONDERGRENS}.`,
        recommendation:
          "Controleer de actuele regels van de gemeenten waar je komt; die verschillen per " +
          "stad en veranderen.",
        based_on: { fuel: b.type, emission_class: b.emission_class },
      });
    }
  }
  if (c.fuel.length === 0) {
    s.push({
      code: "no_fuel_data",
      severity: "info",
      message: "Er zijn geen brandstof- of emissiegegevens geregistreerd voor dit voertuig.",
    });
  }
}

/** "EURO 4" of "4" naar 4. Null als er niets numeriek in staat. */
function getEuroKlasse(v: string | null): number | null {
  if (!v) return null;
  const m = v.match(/(\d)/);
  return m ? Number(m[1]) : null;
}

function herkomst(c: VehicleContext, s: Signaal[]): void {
  const { first_admission, first_admission_nl } = c.identity;
  if (!first_admission || !first_admission_nl) return;
  // Meer dan een half jaar verschil duidt op import in plaats van administratieve vertraging.
  const dagen = (Date.parse(first_admission_nl) - Date.parse(first_admission)) / 86400000;
  if (dagen > 180) {
    s.push({
      code: "imported_vehicle",
      severity: "attention",
      message:
        `Het voertuig is op ${first_admission} voor het eerst toegelaten, maar pas op ` +
        `${first_admission_nl} in Nederland geregistreerd. Het is dus geïmporteerd.`,
      recommendation:
        "De historie van vóór de import — onderhoud, schade, keuringen — staat niet in het " +
        "Nederlandse register. Vraag daar apart naar.",
      based_on: { first_admission, first_admission_nl, gap_days: Math.round(dagen) },
    });
  }
}

function bronnen(c: VehicleContext, s: Signaal[]): void {
  const stuk = c.provenance.filter((b) => b.status === "unavailable" || b.status === "error");
  if (!stuk.length) return;
  s.push({
    code: "source_unavailable",
    severity: "attention",
    message:
      `${stuk.length} van de geraadpleegde registers antwoordde niet: ` +
      `${stuk.map((b) => b.name).join(", ")}. Die onderdelen ontbreken in dit rapport.`,
    recommendation:
      "Behandel de bijbehorende velden als onbekend, niet als leeg. Vraag het rapport later " +
      "opnieuw op.",
    based_on: { sources: stuk.map((b) => ({ name: b.name, status: b.status, note: b.note })) },
  });
}

function diefstalOnbekend(s: Signaal[]): void {
  s.push({
    code: "theft_status_not_published",
    severity: "attention",
    message:
      "Of dit voertuig als gestolen of vermist geregistreerd staat, is niet openbaar. Dat " +
      "gegeven wordt bewust niet als open data verstrekt, dus dit rapport zegt er niets over.",
    recommendation:
      "Een schoon rapport is géén bewijs dat een voertuig niet gestolen is. Controleer dit " +
      "apart bij een aankoop, bijvoorbeeld via de politie of een vrijwaringscheck.",
  });
}
