/**
 * Dutch Vehicle Context — Cloudflare Worker.
 *
 * Eén publieke operatie: geef een agent op één kenteken terug wat het openbare
 * kentekenregister en het terugroepregister over dat voertuig weten, met een hard
 * onderscheid tussen feit, signaal en onbekend.
 *
 * Endpoints:
 *   GET  /health
 *   GET  /v1/vehicle/context?plate=01-TH-FD[&depth=full][&refresh=1]
 *   GET  /                     korte zelfbeschrijving
 *   POST /mcp                  remote MCP (Streamable HTTP), één tool
 *
 * Zusterproject van `dutch-property-context`, en bewust een aparte Worker. Zie DECISIONS/001.
 */
import { laatsteBronDuren } from "./context";
import { mcpHandler } from "./mcp";
import { Depth, parseDepth, vormAntwoord } from "./shape";
import { logTelemetrie } from "./telemetry";
import { haalContext } from "./cache";
import { LimietUitkomst, RateLimiter } from "./ratelimit";

export { RateLimiter };

export interface Env {
  CACHE_TTL_SECONDS?: string;
  RATE_LIMITER?: DurableObjectNamespace<RateLimiter>;
}

const VERSIE = "0.1.0";

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      ...extra,
    },
  });

/**
 * Mag dit verzoek door?
 *
 * Faalt open: als het Durable Object onbereikbaar is gaat het verzoek door, in plaats van
 * dat de dienst omvalt op zijn eigen rem.
 *
 * De grens bestaat hier niet vanwege een licentie — de brondata staat onder CC0 — maar
 * vanwege fair use richting de bronhouder. Eén verzoek hier veroorzaakt tot negen verzoeken
 * daar, dus een open endpoint zou vooral hun platform belasten.
 */
async function binnenLimiet(request: Request, env: Env): Promise<LimietUitkomst> {
  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip || !env.RATE_LIMITER) return { toegestaan: true };
  try {
    const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(ip));
    return await stub.tel(Date.now());
  } catch (e) {
    console.error("rate limiter onbereikbaar, verzoek doorgelaten", e);
    return { toegestaan: true };
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    const isDatapad =
      url.pathname === "/v1/vehicle/context" ||
      url.pathname === "/mcp" ||
      url.pathname.startsWith("/mcp/");
    if (isDatapad) {
      const limiet = await binnenLimiet(request, env);
      if (!limiet.toegestaan) {
        return json(
          {
            error: "Te veel verzoeken. Maximaal 10 per 10 seconden en 60 per minuut per IP.",
            window: limiet.venster,
            retry_after_seconds: limiet.opnieuw_over,
            hint:
              "Eén verzoek hier veroorzaakt meerdere verzoeken bij de bronhouder; die grens " +
              "is fair use. Neem contact op als je structureel meer nodig hebt.",
          },
          429,
          { "retry-after": String(limiet.opnieuw_over ?? 10) },
        );
      }
    }

    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      return mcpHandler()(request, env as never, ctx);
    }

    if (url.pathname === "/health") {
      return json({ status: "ok", version: VERSIE });
    }

    if (url.pathname === "/") {
      return json({
        name: "Dutch Vehicle Context",
        version: VERSIE,
        description:
          "Verificatie- en contextlaag voor Nederlandse voertuigen, bedoeld voor AI-agents. " +
          "Eén kenteken erin, een gekoppeld antwoord eruit: feiten uit het openbare " +
          "kentekenregister, de volledige terugroepketen, terugkerende afkeurpunten, " +
          "deterministische signalen en expliciete onbekenden.",
        endpoints: {
          context:
            "/v1/vehicle/context?plate=01-TH-FD (optioneel &depth=full; standaard compact)",
          mcp: "/mcp (Streamable HTTP, één tool: get_verified_vehicle_context)",
          health: "/health",
        },
        rate_limit:
          "10 verzoeken per 10 seconden en 60 per minuut per IP, op /v1 en /mcp. " +
          "Bij overschrijding volgt HTTP 429 met een Retry-After-header.",
        not_included:
          "Diefstal- en vermissingsstatus zijn geen open data en zitten hier niet in. Een " +
          "rapport zonder diefstalmelding bewijst niet dat een voertuig niet gestolen is.",
        disclaimer:
          "Geen taxatie, geen technische keuring en geen aankoopadvies. Signalen stellen " +
          "geen gebreken vast; onbekende waarden worden nooit ingevuld met een schatting.",
      });
    }

    if (url.pathname !== "/v1/vehicle/context") {
      return json(
        { error: "Onbekend pad.", endpoints: ["/", "/health", "/v1/vehicle/context", "/mcp"] },
        404,
      );
    }

    const plate = (url.searchParams.get("plate") ?? url.searchParams.get("kenteken") ?? "").trim();
    if (!plate) {
      return json({
        error: "Parameter 'plate' ontbreekt.",
        example: "/v1/vehicle/context?plate=01-TH-FD",
      }, 400);
    }

    const ttl = parseInt(env.CACHE_TTL_SECONDS ?? "3600", 10);
    const refresh = url.searchParams.get("refresh") === "1";
    const depth: Depth = parseDepth(url.searchParams.get("depth"));

    try {
      const { context, cache, duur_ms } = await haalContext(
        plate,
        (p) => ctx.waitUntil(p),
        { refresh, ttlSeconden: ttl },
      );
      const vorm = vormAntwoord(context, depth);
      logTelemetrie(context, {
        transport: "http",
        depth,
        cache,
        duur_ms,
        bytes: JSON.stringify(vorm).length,
        bron_ms: cache === "hit" ? undefined : laatsteBronDuren,
      });
      return json(vorm, 200, {
        "x-cache": cache.toUpperCase(),
        "x-latency-ms": String(duur_ms),
        "x-depth": depth,
      });
    } catch (e) {
      if (e instanceof Error && e.name === "KentekenOngeldig") {
        return json({ error: e.message }, 400);
      }
      // Nooit de ruwe fout naar buiten: die bevat bij fetch de volledige opgevraagde URL.
      const incident = crypto.randomUUID().slice(0, 12);
      console.error(`context faalde incident=${incident}`, e);
      return json({
        error: "Het kentekenregister kon niet worden geraadpleegd.",
        incident,
        hint: "Meld dit incident-id als het blijft gebeuren.",
      }, 502);
    }
  },
};
