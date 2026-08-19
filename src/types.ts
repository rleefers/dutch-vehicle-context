/**
 * Datamodel van de voertuigcontext.
 *
 * Overgenomen uit `dutch-property-context`, want de trust-semantiek is het punt van het hele
 * product en die hoort niet per domein te verschillen: elke waarde draagt een status, feiten
 * en signalen staan gescheiden, en een onbekende wordt nooit ingevuld.
 *
 * Eén ding is hier wezenlijk anders. Bij een adres is de moeilijke vraag "hebben we het
 * juiste object te pakken". Bij een kenteken is dat triviaal — een kenteken is uniek en
 * wordt in Nederland niet hergebruikt. De moeilijke vraag verschuift naar: **wat weten we
 * juist níét**. De RDW publiceert bijvoorbeeld bewust geen diefstalstatus. Wie dat niet
 * expliciet maakt, levert een schoon ogend rapport over een gestolen auto.
 */

/** Waarom een waarde er niet is. Nooit stilzwijgend `null` zonder een van deze. */
export type BronStatus =
  | "ok"
  /** Bron bevraagd, kende dit kenteken niet. */
  | "not_found"
  /** Bron bevraagd, gaf een leeg antwoord voor dit kenteken (bestaat wel, geen rijen). */
  | "empty"
  /** Bron publiceert dit gegeven principieel niet. Geen storing: een ontwerpkeuze. */
  | "not_published"
  /** Bron onbereikbaar of te traag. */
  | "unavailable"
  /** Bron antwoordde, maar onbegrijpelijk. */
  | "error";

export interface Bron {
  /**
   * Naam van de bron.
   *
   * Let op: de RDW-bijsluiter verbiedt bij hergebruik expliciet te vermelden dát de gegevens
   * van de RDW komen ("Als onderdeel van Creative Commons Zero is het bij hergebruik niet
   * toegestaan te vermelden dat de gegevens afkomstig zijn van de RDW"). Daarom staat hier
   * de neutrale, feitelijke aanduiding van het register en niet de organisatienaam als merk.
   * Zie DECISIONS/002.
   */
  name: string;
  /** Dataset-identificatie, zodat een antwoord reproduceerbaar is. */
  dataset: string;
  endpoint?: string;
  retrieved_at: string;
  status: BronStatus;
  /** Toelichting bij een andere status dan `ok`. */
  note?: string;
  /** Hoeveel rijen deze bron teruggaf. Nul is informatie, geen fout. */
  rows?: number;
}

/** Een signaal stelt nooit een gebrek vast; het wijst op iets dat aandacht verdient. */
export interface Signaal {
  code: string;
  /** `info` beschrijft, `attention` verdient navraag, `high` hoort bovenaan een advies. */
  severity: "info" | "attention" | "high";
  message: string;
  /** Wat een koper hiermee zou moeten doen. Leeg als er niets te doen valt. */
  recommendation?: string;
  /** Waar dit signaal op gebaseerd is, zodat het narekenbaar is. */
  based_on?: Record<string, unknown>;
}

export interface Identiteit {
  /** Zoals de gebruiker het opgaf. */
  plate_input: string;
  /** Genormaliseerd: hoofdletters, geen streepjes of spaties. Sleutel voor alle bronnen. */
  plate: string;
  /** Leesbaar met streepjes, volgens de sidecode. Null als het formaat onbekend is. */
  plate_formatted: string | null;
  /**
   * Kende het register dit kenteken?
   *
   * Bij `false` gaat de rest van het antwoord nergens over en hoort een agent dat te melden
   * in plaats van de lege velden te presenteren.
   */
  found: boolean;
  vehicle_type: string | null;
  make: string | null;
  trade_name: string | null;
  /** ISO-datum van eerste toelating, waar ook ter wereld. */
  first_admission: string | null;
  /** ISO-datum van eerste toelating in Nederland. Wijkt af bij import. */
  first_admission_nl: string | null;
  /** ISO-datum waarop de huidige tenaamstelling begon. Geen naam, alleen de datum. */
  registered_since: string | null;
  age_years: number | null;
}

export interface Technisch {
  body: string | null;
  doors: number | null;
  seats: number | null;
  mass_empty_kg: number | null;
  mass_max_kg: number | null;
  cylinders: number | null;
  displacement_cc: number | null;
  axles: number | null;
  colour: string | null;
  wheelbase_cm: number | null;
}

export interface Brandstof {
  type: string | null;
  /** EURO-klasse. Bepaalt toegang tot milieuzones. */
  emission_class: string | null;
  co2_combined_gkm: number | null;
  consumption_combined_l100km: number | null;
  /** Elektrisch bereik, alleen bij (plug-in) elektrisch. */
  electric_range_km: number | null;
}

export interface Keuring {
  /** ISO-datum waarop de APK verloopt. */
  expiry_date: string | null;
  days_until_expiry: number | null;
  status: "valid" | "expiring_soon" | "expired" | "unknown";
  /** Bekende eerdere vervaldata, nieuwste eerst. */
  history: string[];
}

export interface GebrekPost {
  code: string;
  /** Vertaald via de codetabel. Null als de code daar niet in staat. */
  description: string | null;
  count: number;
}

export interface GebrekPerKeuring {
  /** ISO-datum van de melding door de keuringsinstantie. */
  date: string;
  items: GebrekPost[];
}

export interface Gebreken {
  /** Aantal registraties, niet aantal unieke gebreken. */
  registrations: number;
  /**
   * Aantal keuringsRONDES, niet aantal datums.
   *
   * Een afkeuring en de herkeuring erna zijn twee datums maar één ronde. Zie de toelichting
   * bij `recurring`; op datums tellen leverde aantoonbaar een vals signaal op.
   */
  inspection_rounds: number;
  by_inspection: GebrekPerKeuring[];
  /**
   * Codes die in meer dan één keuringsronde voorkwamen. `count` is het aantal rondes.
   *
   * Dit is de reden dat deze laag bestaat: één losse afkeuring zegt weinig, dezelfde
   * afkeuring in twee verschillende keuringsrondes zegt dat er iets niet blijvend is
   * opgelost. Die conclusie staat in geen enkele dataset.
   *
   * Let op de valkuil die dit signaal bijna waardeloos maakte: een afgekeurd voertuig komt
   * na reparatie terug voor herkeuring, en dat is een eigen datum met dezelfde gebreken.
   * Op datum tellen meldde daardoor "terugkerend" bij wat één keuringsronde was. Datums
   * binnen 60 dagen horen daarom bij dezelfde ronde.
   */
  recurring: GebrekPost[];
}

export interface Tellerstand {
  /** Het oordeel van het register: Logisch, Onlogisch, Geen oordeel, Niet geregistreerd. */
  judgement: string | null;
  /** De officiële toelichting bij dat oordeel, uit de codetabel. */
  explanation: string | null;
}

export interface Terugroepactie {
  reference: string;
  /** Bijvoorbeeld "Openstaande terugroepactie" of "Producent heeft herstel gemeld". */
  status: string;
  open: boolean;
  defect: string | null;
  consequence: string | null;
  repair: string | null;
  /** Wat er mis kan gaan, uit de risicotabel. Kan meerdere gevaren bevatten. */
  hazards: string[];
  published: string | null;
  manufacturer: string | null;
  vehicles_in_action: number | null;
  more_info_url: string | null;
}

export interface Terugroep {
  /** Het vlaggetje uit het basisregister. */
  has_open_recall: boolean | null;
  /** Alle acties voor dit kenteken, open én afgehandeld. */
  actions: Terugroepactie[];
}

export interface Statusvlaggen {
  /** Is er een geldige WA-verzekering geregistreerd? */
  insured: boolean | null;
  /** Staat het voertuig als geëxporteerd geregistreerd? */
  exported: boolean | null;
  /** Is het voertuig ooit als taxi geregistreerd geweest? */
  taxi_history: boolean | null;
  /** Staat er een WOK (wachten op keuren) open? */
  awaiting_inspection: string | null;
  /**
   * Diefstalstatus.
   *
   * Altijd `null`. De RDW publiceert dit principieel niet als open data — hun eigen
   * toelichting: "De vermelding of een voertuig als gestolen of vermist geregistreerd staat,
   * wordt niet via open data aangeboden." Het veld staat hier juist wél in het model, met
   * een bijbehorend signaal, omdat de afwezigheid ervan anders als "niet gestolen" gelezen
   * wordt. Dat is de gevaarlijkste stilte in deze dataset.
   */
  stolen: null;
}

export interface Waarde {
  /** Catalogusprijs bij introductie, in hele euro's. Geen actuele waarde en geen taxatie. */
  catalogue_price_new_eur: number | null;
}

export interface VehicleContext {
  identity: Identiteit;
  technical: Technisch;
  fuel: Brandstof[];
  inspection: Keuring;
  defects: Gebreken;
  odometer: Tellerstand;
  recalls: Terugroep;
  status_flags: Statusvlaggen;
  value: Waarde;
  signals: Signaal[];
  provenance: Bron[];
  /** Wanneer dit antwoord is samengesteld. */
  generated_at: string;
  disclaimer: string;
}
