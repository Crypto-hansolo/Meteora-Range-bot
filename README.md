# Meteora Delta-Neutral LP Bot

Stellt Liquidität in Meteora-DLMM-Pools mit hoher **24h-Fees/TVL**-Ratio bereit und
neutralisiert das Delta der Position über **Short-Perps auf Hyperliquid**. Ziel: die
Fees einsammeln, ohne eine Richtungswette auf den Token einzugehen.

```
                 ┌──────────────────────┐        ┌─────────────────────────┐
  Kapital  ──────►  Meteora DLMM LP      │        │  Hyperliquid Perp       │
                 │  z.B. SOL/USDC        │        │  z.B. SOL Short         │
                 │  verdient Swap-Fees   │◄──────►│  neutralisiert Delta    │
                 └──────────────────────┘  Delta └─────────────────────────┘
```

---

## 1. Welche Gegenposition, und warum genau die?

Die zentrale Frage. Antwort für eine SOL/USDC-Position: **Short auf SOL, in exakt der
Höhe der SOL-Menge, die die LP-Position gerade hält.** Nicht die Hälfte des Kapitals,
nicht ein fester Betrag — die aktuell gehaltene Token-Menge.

### Der Beweis

Die Position hält `x` SOL und `y` USDC. In USDC gerechnet ist sie wert:

```
V(P) = x(P) · P + y(P)
```

Innerhalb eines DLMM-Bins laufen alle Swaps zum festen Bin-Preis. Eine
infinitesimale Preisbewegung tauscht also genau zum Preis `P`:

```
P · dx + dy = 0
```

Eingesetzt in die Ableitung von `V`:

```
dV/dP = x + P·(dx/dP) + dy/dP = x + (P·dx + dy)/dP = x
```

**Das Delta der Position, in SOL-Einheiten, ist genau die gehaltene SOL-Menge.**
Kein Uniswap-v3-Closed-Form nötig, und es gilt für jede Liquiditäts-Verteilung
(Spot, Curve, BidAsk). Der Hedge ist ein Short über `x` SOL.

Implementierung: [`src/math/deltaNeutral.ts`](src/math/deltaNeutral.ts)

### Warum der Hedge dynamisch sein muss

`x` ist **nicht konstant**. Bei einer ±5%-Range um 200 $:

| SOL-Preis | Position hält | Delta | Nötiger Short |
|-----------|---------------|-------|---------------|
| 190 $ (Range-Boden) | ~alles SOL | maximal | groß |
| 200 $ (Mitte) | ~50/50 | ~halbes Kapital | mittel |
| 210 $ (Range-Top) | ~alles USDC | ~0 | ~keiner |

Steigt der Preis, verkauft die LP-Position automatisch SOL — das Delta schrumpft und
der Short muss zurückgekauft werden. Fällt der Preis, umgekehrt. Genau deshalb ist
ein einmalig gesetzter Hedge falsch: der Bot liest jeden Tick die echten On-Chain-
Beträge und passt den Short an, sobald die Abweichung `HEDGE_REBALANCE_THRESHOLD_PCT`
überschreitet.

### Pools mit zwei volatilen Seiten

Bei z.B. wBTC/SOL trägt **jede** Seite ihr eigenes Delta (`y` ist ein gewöhnlicher
Spot-Bestand mit Delta 1). Der Bot öffnet dann zwei Shorts — einen pro Asset — und
fasst Beiträge zusammen, wenn beide Seiten auf dasselbe Perp zeigen.

---

## 2. Welcher Einsatz, welcher Hebel?

Der Hebel wird **nicht** geraten, sondern aus einer Liquidations-Sicherheitsbedingung
gelöst.

### Die Bedingung

Ein Short kann nur nach **oben** liquidiert werden. Oberhalb des Range-Tops hört die
LP-Position auf zu gewinnen, während der Short weiter verliert — dort endet die
Absicherung. Also muss der Liquidationspreis deutlich **über** dem Range-Top liegen.

```
Liquidation muss hierhin ────────────────────────────►  +25%
Range-Top (LP hört auf zu gewinnen) ──►  +5%
Spot ────────────────────────────────►   0%
Range-Boden ──────────────────────►      -5%
```

### Die Rechnung

Liquidation tritt ein, wenn das isolierte Eigenkapital auf die Maintenance-Margin
fällt (`C` = Margin, `S` = Short-Größe, `P0` = Entry, `mmf` = Maintenance-Rate):

```
C + S·(P0 − P) = S·P·mmf     ⟹     P_liq = (C/S + P0) / (1 + mmf)
```

Mit `C = S·P0/L` folgt der Puffer als Funktion des Hebels — und umgekehrt:

```
buffer = P_liq/P0 − 1 = (1/L − mmf) / (1 + mmf)

⟹   L = 1 / (buffer·(1 + mmf) + mmf)
```

`mmf` kommt aus Hyperliquids Margin-Tiers (`mmf = 1/(2·maxLeverage)` der Stufe, nach
Notional gestaffelt).

### Konkret: 1000 $ in SOL/USDC, `RANGE_WIDTH_PCT=5`, SOL bei 200 $

Reale Ausgabe des Planners (Bin-Step 20, Defaults sonst):

```
Range                -4.68% .. +4.91%   (49 Bins)
Split                50.0% SOL / 50.0% USDC
Einzahlung           2.5 SOL (500 $) + 500 USDC
Delta                2.5 SOL
Short-Notional       500 $
Erforderl. Puffer    max(4.91% × 3, 25%) = 25%
mmf (SOL, 20x-Tier)  1/40 = 2.5%
Hebel                1/(0.25·1.025 + 0.025) = 3.56x  →  abgerundet 3x
Hedge-Margin         500 $ / 3 = 166.67 $
Gesamtkapital        1166.67 $
Liquidation          260.16 $  = +30.1%   (Range-Top ist +4.91%) ✓
```

Der Hebel wird **abgerundet**, damit der echte Puffer nie schlechter ist als geplant
(3x ergibt +30.1% statt der geforderten +25%). Danach greifen die Deckel
`HEDGE_MAX_LEVERAGE` und das Venue-Maximum.

Die Range ist symmetrisch in *Bins*, also in *log*-Preis — deshalb ist die
Oberseite (+4.91%) etwas weiter als die Unterseite (-4.68%). Genau so verhält sich
auch Meteoras eigenes UI.

### Warum das die Rendite-Rechnung verändert

Die Hedge-Margin ist gebundenes Kapital, das keine Fees verdient. Eine reine
Fees/TVL-Rangliste ist deshalb irreführend. Der Bot bewertet Pools nach
**Netto-APR auf Gesamtkapital** (LP + Margin), inklusive Perp-Funding:

```
Netto-APR = (Fees auf LP-Kapital + Funding auf Short-Notional) / (LP-Kapital + Margin)
```

Positives Funding ist ein Bonus (Longs zahlen Shorts), negatives ein laufender
Kostenblock — bei einem dauerhaft geshorteten Asset kann das den Fee-Vorteil
komplett aufessen. Deshalb steht Funding in `scan` als eigene Spalte.

---

## 3. Setup

```bash
npm install
cp .env.example .env      # ausfüllen
```

Pflicht:

| Variable | Zweck |
|----------|-------|
| `RPC_URL` | Solana-RPC. Ein privater Endpoint ist praktisch Pflicht, der öffentliche rate-limitet. |
| `SOLANA_PRIVATE_KEY` | Base58 (Phantom-Export) oder JSON-Byte-Array (`solana-keygen`). |
| `HL_PRIVATE_KEY` | Hyperliquid-Key. **Nutze ein API-/Agent-Wallet** — es kann traden, aber nicht auszahlen. |
| `HL_ACCOUNT_ADDRESS` | Nur nötig, wenn oben ein Agent-Wallet steht: Reads müssen auf den Master-Account zeigen. |

`DRY_RUN` steht auf `true` und muss bewusst auf `false` gesetzt werden.

---

## 4. Benutzung

```bash
npm run scan                        # Pools ranken
npm run plan -- <pool-address>      # kompletter Plan, ohne zu traden
npm run run  -- <pool-address>      # öffnen + Hedge nachführen
npm run status                      # laufende Session
npm run close                       # alles auflösen
```

`scan` ohne Argument, dann `plan`, dann `run` ist der normale Weg. `run` ohne
Pool-Adresse nimmt automatisch den besten Scan-Treffer.

Format der `scan`-Ausgabe (Zeile 1 sind echte Planner-Werte für die obige
Beispiel-Konstellation, Zeile 2 ist zur Illustration des Layouts):

```
  # Pool                  TVL      Fees24h  Fee/TVL  LP APR   Fund APR  Net APR  Hedge
  1 SOL-USDC              2.1M       48k      2.29%   834.3%      5.5%   719.8%  2.500 SOL@3x
  2 JUP-USDC              780k       12k      1.54%   561.0%     -3.1%   470.2%  1021.4 JUP@3x
```

> **Zu den APR-Zahlen:** `LP APR` ist die simple Annualisierung von 24h-Fees
> (`Fee/TVL × 365`). Dreistellige Werte sind kein Versprechen — eine
> Fees/TVL-Ratio von 2%/Tag entsteht durch einen Volatilitäts-Spike und hält
> praktisch nie ein Jahr. Nutze die Spalte zum *Vergleichen* von Pools, nicht als
> Ertragsprognose. `Fund APR` ist auf LP-Kapital normiert, damit beide Spalten
> dieselbe Basis haben.

---

## 5. Ablauf & Reihenfolge

**Öffnen** — Hedge zuerst, LP danach:

1. Plan gegen den echten Active-Bin neu rechnen
2. Wallet-Deckung prüfen (der Bot swappt nicht, siehe Grenzen)
3. Hebel + Margin-Modus auf Hyperliquid setzen
4. **Short öffnen**
5. **LP-Position öffnen**
6. Hedge gegen die echten On-Chain-Beträge nachjustieren

Begründung für die Reihenfolge: das LP-Bein ist das langsame, fehleranfällige
(mehrere Instructions, Blockhash-Ablauf, Slippage-Guards), der Perp-Short ein
einzelner schneller Call. Bricht es zwischen den Beinen ab, bleibt ein **Short**
übrig — eine verstandene, schließbare Position — statt eines nackten Spot-Bestands.
Scheitert Schritt 5, wird der Hedge automatisch zurückgedreht.

**Schließen** — genau umgekehrt: erst LP abziehen, dann den Short reduce-only
flatten. Andersherum wäre der Spot-Bestand während der langsamen On-Chain-
Bestätigung ungehedgt.

**Jeder Tick** (`POLL_INTERVAL_MS`):

- Delta aus den echten Position-Beträgen lesen (inkl. nicht geclaimter Fees — die
  liegen als Spot-Bestand in der Position und bewegen sich mit)
- Short anpassen, wenn Drift > Schwelle und Cooldown vorbei
- Isolierte Margin nachfüllen, wenn der effektive Hebel über
  `HEDGE_MARGIN_TOPUP_LEVERAGE` läuft
- Fees claimen (Intervall)
- Exit prüfen: zu lange out of range, oder Drawdown über `MAX_DRAWDOWN_PCT`

---

## 6. Sicherheits-Entscheidungen

**Mint-Allowlist statt Symbol-Namen.** Das `name`-Feld der Meteora-API
("SOL-USDC") ist angreifbar: jeder kann einen Token namens `SOL` deployen und einen
DLMM-Pool damit seeden. Ein Bot, der dem String traut, würde in den Fake-Pool
einzahlen und dagegen einen **echten** SOL-Short öffnen — eine ungehedgte
Richtungswette mit Extraschritten. Deshalb entscheidet ausschließlich die
Mint-Adresse ([`src/tokens.ts`](src/tokens.ts)); Pool-Namen sind nur Anzeige.
Erweitern über `TOKEN_MAP_JSON` — jede Mint vorher selbst verifizieren.

**Liquid-Staking-Tokens sind ausgeschlossen.** 1 JitoSOL ist mehr als 1 SOL und das
Verhältnis driftet. Ein 1:1-SOL-Short würde systematisch falsch hedgen. Sie sind
explizit als `unhedgeable` markiert statt still falsch behandelt.

**Perp-Liquidität wird geprüft.** Pools, deren Asset unter
`MIN_HL_OPEN_INTEREST_USD` Open Interest hat, fallen raus — ein Hedge, den man nicht
schließen kann, ist kein Hedge.

**IOC statt Market Orders.** Der Bot preist Limit-Orders um `HEDGE_SLIPPAGE_BPS`
durchs Buch. Was nicht innerhalb der Bande füllt, wird gecancelt und im nächsten
Tick erneut versucht, statt das ganze Orderbuch zu fressen.

**Tolerante API-Schemas.** Alle Metriken der Meteora-API sind optional und werden
gecoerct, unbekannte Felder laufen durch. Ein kosmetisches API-Update legt den Bot
nicht lahm. Die Fees/TVL-Ratio wird selbst aus `fees_24h / liquidity` gerechnet,
weil die Einheit des API-Felds `fee_tvl_ratio` (Bruch vs. Prozent) historisch
gewechselt hat.

---

## 7. Grenzen — bitte lesen

**Der Bot swappt nicht.** Er zahlt ein, was das Wallet schon hält. Für eine
±5%-SOL/USDC-Position brauchst du also ~50% SOL und ~50% USDC vorab. Fehlt etwas,
bricht er *vor* jeder irreversiblen Aktion mit einer genauen Bedarfsliste ab. Ein
Jupiter-Swap-Schritt wäre die naheliegende Erweiterung.

**Delta-neutral ist nicht risikofrei.** Was bleibt:

- *Loss-versus-Rebalancing / IL*: Der Hedge neutralisiert die erste Ableitung, nicht
  die Konvexität. Die LP-Position ist short Gamma; bei hoher Realized Volatility
  kostet das Rebalancing mehr, als die Fees einbringen.
- *Funding*: Ein dauerhafter Short zahlt bei negativem Funding laufend.
- *Basis*: Meteora-Poolpreis und Hyperliquid-Mark laufen auseinander.
- *Rebalancing-Kosten*: Jede Nachjustierung zahlt Taker-Fees und Slippage. Eine
  engere Schwelle hedgt genauer und kostet mehr.
- *Ausführungslücken*: Zwischen den beiden Beinen existiert ein kurzes Fenster.

**Nicht live gegen die Mainnet-APIs getestet.** Die Entwicklungsumgebung hatte keinen
Netzwerkzugang zu `dlmm-api.meteora.ag` und `api.hyperliquid.xyz`. Alle SDK-Aufrufe
sind gegen die installierten Typdefinitionen von `@meteora-ag/dlmm@1.9.14` und
`@nktkas/hyperliquid@0.33.2` geschrieben und typgeprüft, und die Selektions-/
Planungs-/Sizing-Logik ist offline durchgetestet (93 Tests) — aber **fahre zuerst
`DRY_RUN=true`**, dann einen kleinen Betrag, bevor du Kapital drauflegst.

---

## 8. Projektstruktur

```
src/
  index.ts               CLI: scan | plan | run | status | close
  config.ts              Env-Validierung (zod)
  tokens.ts              Mint-Allowlist, Perp-Mapping, Stable-Erkennung
  solana.ts              Connection, Wallet, Tx-Senden mit Priority Fees
  math/
    deltaNeutral.ts      Delta-Beweis, Hedge-Sizing, Liquidation, Leverage-Solve
    bins.ts              Bin-Geometrie, Range-Planung
  meteora/
    api.ts               REST-Client für Pool-Metriken
    scoring.ts           Filter + Ranking nach Netto-APR
    dlmm.ts              On-Chain: öffnen, lesen, claimen, schließen
    sdk.ts               CJS-Interop-Shim (siehe unten)
  hedge/
    hyperliquid.ts       Info-/Exchange-Client, Orders, Margin
  strategy/
    planner.ts           Pool + Markt → vollständiger Plan
    engine.ts            Session-Ablauf: open / tick / close
  state/store.ts         Atomar geschriebener JSON-State
  util/                  HTTP mit Retries, Balance-Prüfung
test/                    93 Offline-Tests
```

### Zur `meteora/sdk.ts`-Datei

`@meteora-ag/dlmm` hat zwei Packaging-Eigenheiten, die beide dort gekapselt sind:

1. Der ESM-Build (`dist/index.mjs`) macht einen Directory-Import in Anchors
   CJS-Dist, was Nodes ESM-Resolver mit `ERR_UNSUPPORTED_DIR_IMPORT` ablehnt. Der
   CJS-Build wird deshalb explizit über `createRequire` geladen.
2. Eine `.d.ts` bedient beide Builds, wodurch ein Default-Import als Modul-Namespace
   statt als Klasse typisiert wird — der Konstruktor liegt eine Ebene tiefer.

---

## 9. Entwicklung

```bash
npm test          # 93 Offline-Tests, kein Netzwerk nötig
npm run typecheck # tsc --noEmit
npm run build     # -> dist/
```

Die Tests decken die Mathematik (Delta, Liquidation, Leverage-Solve, Rebalancing-
Vorzeichen), die Bin-Geometrie und den kompletten Selektions- und Planungspfad mit
synthetischen Pool-Rows und gestubbten Märkten ab.

## Lizenz

MIT
