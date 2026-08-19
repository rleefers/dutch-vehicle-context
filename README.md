# Dutch Vehicle Context — MCP server & API voor Nederlandse kentekens

Eén kenteken erin, één gekoppeld voertuigrapport eruit. APK-historie, afkeurpunten met
leesbare omschrijving, het officiële oordeel over de kilometerstand, en de **volledige
terugroepketen** — inclusief wat er stuk kan, hoe gevaarlijk dat is en wat het herstel is.

Draait als **remote MCP-server** en als gewone HTTPS-API. Gratis, geen API-sleutel, geen
registratie.

```
https://vehicle-context.tradebrite.nl
```

📖 **Documentatie:** https://tradebrite.nl/vehicle-context/

---

## Aansluiten in 10 seconden

```bash
claude mcp add --transport http vehicle-context https://vehicle-context.tradebrite.nl/mcp
```

Of in je MCP-configuratie (Claude Desktop, Cursor, Windsurf, …):

```json
{
  "mcpServers": {
    "vehicle-context": {
      "type": "http",
      "url": "https://vehicle-context.tradebrite.nl/mcp"
    }
  }
}
```

Daarna kun je vragen: *"Wat weet je van kenteken 01-TH-FD, is dat een verstandige koop?"*

Liever gewoon HTTP:

```bash
curl "https://vehicle-context.tradebrite.nl/v1/vehicle/context?plate=01-TH-FD"
```

## Waarom dit bestaat

Alle onderliggende gegevens zijn openbaar en gratis. Het probleem is de versnippering: het
antwoord op een normale vraag staat verspreid over elf datasets en twee codetabellen, en de
interessantste conclusies staan in géén enkele daarvan.

Twee voorbeelden uit de praktijk.

**De terugroepketen.** Het basisregister meldt over een openstaande actie niet meer dan `Ja`.
Wil je weten wélke actie, dan moet je van kenteken naar referentiecode (`t49b-isb7`), naar de
actiebeschrijving (`j9yg-7rg9`), naar de gevarenlijst (`9ihi-jgpf`). Bij het testvoertuig
leverde dat twee acties op: een afgehandelde uit 2018 en een openstaande uit 2024 over een
airbag-gasgenerator die bij een ongeval kan exploderen. **Wie de eerste rij pakt, rapporteert
de verkeerde.**

**Terugkerende gebreken.** Eén afkeuring zegt weinig — dat wordt gerepareerd. Dezelfde
afkeuring in drie opeenvolgende jaren zegt dat er iets structureel niet in orde is. Die
conclusie staat nergens; hij ontstaat pas door registraties per keuringsronde te groeperen.
En let op de valkuil die ons bijna te pakken had: een herkeuring ná reparatie is een eigen
datum met dezelfde gebreken. Op datum tellen levert vals alarm. Zie
[`src/context.ts`](src/context.ts).

## Wat je terugkrijgt

Eén JSON-antwoord (~10 kB) met `identity`, `technical`, `fuel`, `inspection`, `defects`,
`odometer`, `recalls`, `status_flags`, `value`, `signals` en `provenance`.

De laag die dit bruikbaar maakt voor een agent is `signals` — observaties die nooit een gebrek
vaststellen, gesorteerd op ernst, elk met een aanbeveling en de onderbouwing:

| Signaal | Betekenis |
|---|---|
| `open_recall` | Openstaande terugroepactie, met defect, gevaar en herstel |
| `recurring_defect` | Zelfde afkeurpunt in meerdere keuringsrondes |
| `odometer_illogical` | Register beoordeelt de kilometerstand als onlogisch |
| `odometer_no_judgement` | Er is géén oordeel — dat is iets anders dan een goedkeuring |
| `imported_vehicle` | Historie van vóór de import ontbreekt in het NL-register |
| `emission_zone_restricted` | Diesel onder EURO 5 |
| `apk_expired`, `not_insured`, `exported`, `taxi_history`, `source_unavailable` | … |

## Wat het níét doet

> **Diefstalstatus zit er niet in, en dat is geen omissie.** Of een voertuig als gestolen of
> vermist geregistreerd staat wordt principieel niet als open data verstrekt. Elk antwoord
> meldt dat expliciet, óók als de rest schoon is — anders leest een volledig ogend rapport
> zonder diefstalvermelding als "niet gestolen", en dat is de gevaarlijkste conclusie die
> iemand uit deze gegevens kan trekken.

Verder: geen taxatie, geen technische keuring, geen aankoopadvies. Geen schadeverleden, geen
aantal eigenaren, geen actuele kilometerstand — die staan niet in de open registers.

## Ontwerpprincipes

1. **Nooit een ontbrekende waarde invullen omdat hij waarschijnlijk lijkt.** Elke bron draagt
   een status: `ok` / `not_found` / `empty` / `not_published` / `unavailable` / `error`.
2. **FEIT ≠ SIGNAAL ≠ ONBEKEND.**
3. **Wat niet openbaar is, wordt expliciet als onbekend gemeld.**
4. **Eén MCP-tool, niet tientallen.** Onze toollijst is 2.347 tekens. Een brede
   Nederlandse open-data-MCP die we ernaast legden: 55.452 tekens voor 64 tools — ongeveer
   15.000 tokens die een agent moet inlezen vóór hij iets kan vragen.
5. **Een falende bron faalt zichtbaar.** Stilte mag niet lijken op "niets te melden".
6. **Elke afgeleide conclusie draagt zijn onderbouwing** in `based_on`.

## Zelf draaien

```bash
npm install
npx wrangler deploy      # vul eerst je eigen account_id in wrangler.toml
node regression.mjs      # acht gevallen tegen de live dienst
```

Geen sleutels nodig — alle bronnen zijn publiek. Geen voorberekende data in de bundle, alles
wordt live bevraagd (240–480 ms per bron, parallel).

## Bronnen en licentie

Elf datasets uit het Nederlandse kentekenregister en het terugroepregister, allemaal
beschikbaar onder **Creative Commons Zero**. Let op: de bronhouder stáát bronvermelding bij
hergebruik uitdrukkelijk niet toe en verbiedt gebruik van naam en logo, dus die staan hier
bewust niet in — alleen de neutrale registeraanduiding plus de dataset-id.

De bronhouder geeft geen garantie op beschikbaarheid en mag datasets zonder opgaaf intrekken.
Performance is fair use; vandaar de rate limit van 10 verzoeken per 10 s en 60 per minuut per
IP op de gehoste dienst.

**Code:** MIT, zie [LICENSE](LICENSE).

## Privacy

Een kenteken kan een persoonsgegeven zijn. De gehoste dienst logt **geen kentekens en geen
IP-adressen** — een logbestand met kentekens plus tijdstippen zou precies de koppeling maken
die in de brondata ontbreekt. Wel: merk, bouwjaar, voertuigsoort en de afgegeven signalen.

## Verwant

**[Dutch Property Context](https://github.com/rleefers/dutch-property-context)** — dezelfde
aanpak voor Nederlandse woningen: adres erin, bouwjaar, energielabel, buurtcijfers,
monumentstatus en scholen eruit.

---

Gebouwd door [Tradebrite BV](https://tradebrite.nl) · info@tradebrite.nl
