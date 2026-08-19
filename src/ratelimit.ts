/**
 * Rate limiting per IP, via een SQLite-backed Durable Object.
 *
 * Waarom niet de ingebouwde `ratelimit`-binding, die hiervoor bedoeld lijkt: die is op dit
 * account gemeten en telt niet. Op 2026-08-16 gingen 40 opeenvolgende verzoeken met dezelfde
 * sleutel er allemaal doorheen, en `wrangler tail` liet zien dat de binding wel degelijk
 * werd aangeroepen (`limiters=2`, IP correct) maar 40 keer `{"success":true}` teruggaf.
 * Cloudflare noemt die API zelf "permissive, eventually consistent, and intentionally
 * designed to not be used as an accurate accounting system".
 *
 * Voor hygiëne was dat genoeg geweest. Hier niet: dit is een licentievoorwaarde. De
 * EP-Online-voorwaarden verbieden het doorleveren van individuele gegevens "in grote
 * aantallen", dus de grens moet daadwerkelijk sluiten. Een Durable Object is
 * enkeldradig en sterk consistent, dus de telling klopt gewoon.
 *
 * Durable Objects met SQLite-opslag zitten in het gratis Workers-plan, en Cloudflare rekent
 * op dat plan geen opslagkosten. Eén object per IP.
 */
import { DurableObject } from "cloudflare:workers";

/** Vast venster: `aantal` verzoeken per `secondes`. */
export interface Venster {
  naam: string;
  aantal: number;
  secondes: number;
}

export const VENSTERS: Venster[] = [
  { naam: "burst", aantal: 10, secondes: 10 },
  { naam: "sustained", aantal: 60, secondes: 60 },
];

export interface LimietUitkomst {
  toegestaan: boolean;
  /** Welk venster vol zat, als er geweigerd is. */
  venster?: string;
  /** Seconden tot dat venster opnieuw ruimte heeft. */
  opnieuw_over?: number;
}

export class RateLimiter extends DurableObject {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.sql = ctx.storage.sql;
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS vensters (naam TEXT PRIMARY KEY, start INTEGER, aantal INTEGER)",
    );
  }

  /**
   * Tel dit verzoek en zeg of het door mag.
   *
   * Vast venster, geen sliding window: eenvoudiger, en het randgeval (twee keer de limiet
   * rond een venstergrens) is hier niet erg. Het gaat om leegtrekken tegenhouden, niet om
   * een exacte quotumadministratie.
   *
   * Alle vensters worden geteld vóórdat er geweigerd wordt, zodat een afnemer die tegen de
   * burstgrens aanloopt niet stilletjes zijn minuutbudget spaart.
   */
  async tel(nuMs: number): Promise<LimietUitkomst> {
    let uitkomst: LimietUitkomst = { toegestaan: true };

    for (const v of VENSTERS) {
      const rijen = [...this.sql.exec<{ start: number; aantal: number }>(
        "SELECT start, aantal FROM vensters WHERE naam = ?", v.naam,
      )];
      const duurMs = v.secondes * 1000;
      let start = rijen[0]?.start ?? 0;
      let aantal = rijen[0]?.aantal ?? 0;

      if (nuMs - start >= duurMs) {
        start = nuMs;
        aantal = 0;
      }
      aantal += 1;
      this.sql.exec(
        "INSERT INTO vensters (naam, start, aantal) VALUES (?, ?, ?) " +
        "ON CONFLICT(naam) DO UPDATE SET start = excluded.start, aantal = excluded.aantal",
        v.naam, start, aantal,
      );

      if (aantal > v.aantal && uitkomst.toegestaan) {
        uitkomst = {
          toegestaan: false,
          venster: v.naam,
          opnieuw_over: Math.max(1, Math.ceil((start + duurMs - nuMs) / 1000)),
        };
      }
    }
    return uitkomst;
  }
}
