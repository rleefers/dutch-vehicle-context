/**
 * Remote MCP-endpoint op /mcp, via Streamable HTTP.
 *
 * Eén tool. Dat is niet luiheid maar het uitgangspunt van het product, en sinds 2026-08-19
 * ook gemeten: de breedste Nederlandse open-data-MCP heeft 64 tools en zijn toollijst alleen
 * al is 55.452 tekens, ruwweg 15.000 tokens die een agent moet inlezen vóór hij iets kan
 * vragen. De onze is 2.419 tekens. Meer tools in één server is niet rijker, het is duurder
 * en verwarrender — diezelfde server koos bij een woningvraag een CBS-tabel over
 * vruchtbaarheid die in 2008 is stopgezet.
 *
 * Transport: Streamable HTTP via de stateless `createMcpHandler`. SSE is door Cloudflare als
 * verouderd gemarkeerd en de stateful `McpAgent`-route wordt voor nieuwe servers afgeraden.
 */
import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { laatsteBronDuren } from "./context";
import { haalContext } from "./cache";
import { Depth, vormAntwoord } from "./shape";
import { logTelemetrie } from "./telemetry";

function createServer() {
  const server = new McpServer({
    name: "Dutch Vehicle Context",
    version: "0.1.0",
  });

  server.registerTool(
    "get_verified_vehicle_context",
    {
      description:
        "Geeft de geverifieerde context van een Nederlands voertuig op kenteken, uit het " +
        "openbare kentekenregister en het terugroepregister. Gebruik dit bij elke vraag " +
        "over een concrete Nederlandse auto, motor, bestelbus of aanhanger — bijvoorbeeld " +
        "bij het beoordelen van een occasion, het controleren van de APK, of de vraag of " +
        "er een terugroepactie openstaat.\n\n" +
        "Het antwoord heeft deze blokken: `identity` (merk, type, bouwjaar, leeftijd), " +
        "`technical`, `fuel` (brandstof en emissieklasse), `inspection` (APK met historie), " +
        "`defects` (afkeurpunten per keuring, mét terugkerende gebreken), `odometer` " +
        "(oordeel over de kilometerstand), `recalls` (terugroepacties, open én afgehandeld, " +
        "met defect, gevolg, gevaar en herstel), `status_flags`, `value`, `signals` en " +
        "`provenance`.\n\n" +
        "`signals` zijn observaties, geen vastgestelde gebreken. Ze staan gesorteerd op " +
        "ernst; begin daarmee. Let vooral op `open_recall`, `odometer_illogical` en " +
        "`recurring_defect` — dat laatste betekent dat hetzelfde punt bij meerdere " +
        "keuringen is afgekeurd.\n\n" +
        "BELANGRIJK, twee dingen. Ten eerste: als `identity.found` false is, bestaat het " +
        "kenteken niet in het register en gaat de rest van het antwoord nergens over; meld " +
        "dat dan in plaats van lege velden te presenteren. Ten tweede: of een voertuig als " +
        "gestolen of vermist geregistreerd staat is NIET openbaar en staat hier dus niet " +
        "in. Een rapport zonder diefstalmelding is geen bewijs dat een voertuig niet " +
        "gestolen is — zeg dat er expliciet bij als iemand naar de betrouwbaarheid van een " +
        "aankoop vraagt.\n\n" +
        "Dit is geen taxatie, geen technische keuring en geen aankoopadvies.",
      inputSchema: {
        plate: z
          .string()
          .min(6)
          .describe(
            "Nederlands kenteken, met of zonder streepjes: '01-TH-FD', '01THFD' of " +
              "'01 th fd' werken allemaal. Zes tekens.",
          ),
        depth: z
          .enum(["compact", "full"])
          .optional()
          .describe(
            "Hoeveel detail. 'compact' (standaard) geeft alleen de laatste keuring en kort " +
              "de afgehandelde terugroepacties in; alle feiten en álle signalen blijven " +
              "erin, en een openstaande terugroepactie blijft altijd volledig. Vraag " +
              "'full' voor de complete keuringshistorie en de bron-URL's.",
          ),
      },
    },
    async ({ plate, depth }: { plate: string; depth?: Depth }) => {
      try {
        const { context, cache, duur_ms } = await haalContext(plate, () => {});
        const gekozen: Depth = depth === "full" ? "full" : "compact";
        const body = vormAntwoord(context, gekozen);
        logTelemetrie(context, {
          transport: "mcp",
          depth: gekozen,
          cache,
          duur_ms,
          bytes: JSON.stringify(body).length,
          bron_ms: cache === "hit" ? undefined : laatsteBronDuren,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
      } catch (e) {
        // Een fout hoort als tekst terug, niet als protocolfout: de agent moet hem aan de
        // gebruiker kunnen uitleggen.
        const melding =
          e instanceof Error && e.name === "KentekenOngeldig"
            ? e.message
            : "Het kentekenregister was niet bereikbaar. Probeer het later opnieuw.";
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: melding }, null, 2) }],
          isError: true,
        };
      }
    },
  );

  return server;
}

/** Eén handler per isolate; er is geen sleutel of env die hem kan laten verlopen. */
let gecachedeHandler: ReturnType<typeof createMcpHandler> | null = null;

export function mcpHandler() {
  if (!gecachedeHandler) gecachedeHandler = createMcpHandler(() => createServer());
  return gecachedeHandler;
}
