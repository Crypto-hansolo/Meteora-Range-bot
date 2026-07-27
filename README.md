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

**Beim ersten Mal** — holt den Quellcode von GitHub auf die Festplatte:

```bash
git clone https://github.com/Crypto-hansolo/Meteora-Range-bot
cd Meteora-Range-bot
npm install
cp .env.example .env
```

**Danach immer** — der Ordner ist schon da, es fehlen nur die neuen Commits:

```bash
cd Meteora-Range-bot
git pull
npm install     # nur nötig, wenn neue Abhängigkeiten dazugekommen sind
```

`git clone` brauchst du nie wieder, außer du löschst den Ordner.

Node 20 oder neuer. Wer nicht gern im Terminal arbeitet: GitHub Desktop macht
Klonen und Aktualisieren per Knopfdruck, der Rest läuft trotzdem über die
Kommandozeile.

> **Kurz zum Unterschied:** `git clone` holt den *Quellcode* aus dem Repo.
> `npm install` holt die *Bibliotheken*, die dieser Code braucht (Solana-SDK,
> Hyperliquid-SDK und so weiter) nach `node_modules/`. Ein
> `npm install meteora-range-bot` gibt es nicht — das Projekt ist nicht als
> Paket in der npm-Registry veröffentlicht, sondern Quellcode in deinem Repo.

### Welche Keys wofür?

| Befehl | Solana-Key | Hyperliquid-Key | RPC |
|--------|-----------|-----------------|-----|
| `scan`, `plan` | – | – | – |
| `simulate`, `scenario` | – | – | – |
| `backtest` | – | – | – |
| **`paper`** | – | – | ✓ |
| `run`, `close`, `status` | ✓ | ✓ | ✓ |

**Für Paper Trading brauchst du keinen einzigen privaten Schlüssel.** Es liest
nur: Pool-Daten von Meteora, Preise und Funding von Hyperliquid, den aktiven Bin
von der Chain. Positionen und Fills sind simuliert, der State liegt in einer
eigenen Datei (`data/state.paper.json`) und kann eine echte Session nicht
berühren. Abgesichert in [`test/credentials.test.ts`](test/credentials.test.ts),
damit es nicht still kaputtgeht.

### Minimal-`.env` für Paper Trading

```bash
RPC_URL=https://api.mainnet-beta.solana.com
```

Das reicht. Der öffentliche Endpoint rate-limitet aber spürbar — bei einem
Poll-Intervall von 30 s geht es meist gut, für längere Läufe hol dir einen
kostenlosen Key bei Helius, QuickNode oder Alchemy und trag dessen URL ein.

### Für den Live-Betrieb, später

| Variable | Woher |
|----------|-------|
| `SOLANA_PRIVATE_KEY` | Phantom → Einstellungen → Private Key exportieren (Base58), oder `solana-keygen` (JSON-Array). **Eigenes Wallet nehmen, nicht das Haupt-Wallet.** |
| `HL_PRIVATE_KEY` | Hyperliquid → API → **API Wallet erzeugen**. Das kann traden, aber nicht auszahlen. Niemals den Key deines Haupt-Wallets. |
| `HL_ACCOUNT_ADDRESS` | Deine Hyperliquid-Hauptadresse. Nur nötig, weil ein API-Wallet zwar handelt, die Positionen aber auf dem Hauptkonto liegen. |

`DRY_RUN` steht auf `true` und muss bewusst auf `false` gesetzt werden, bevor
irgendetwas Echtes passiert.

### Erste Schritte

```bash
npm test                            # 232 Tests, kein Netz nötig
npm run scan                        # welche Pools gibt es? (ohne Keys)
npm run backtest -- <pool-address>  # echte 90-Tage-Historie des Kandidaten
npm run paper -- <pool-address>     # Live-Preise, simulierte Fills
```

`scan` liefert dir die Pool-Adressen für die anderen Befehle. Läuft der Scan ins
Leere, sind die Filter zu streng — `MIN_FEE_TVL_RATIO_24H` und `MIN_TVL_USD`
sind die üblichen Verdächtigen.

Beim Paper-Lauf: der Bot pollt alle 30 s (`POLL_INTERVAL_MS`). Bei ruhigem Markt
siehst du minutenlang nur „drift unter Schwelle". Wenn du schneller etwas sehen
willst, setz `HEDGE_REBALANCE_THRESHOLD_PCT=1` — dann handelt er sichtbar öfter.
Beenden mit Strg-C; die simulierte Position bleibt im State stehen, `npm run
close` räumt auf.

## 4. Benutzung

```bash
npm run scan                        # Pools ranken
npm run plan -- <pool-address>      # kompletter Plan, ohne zu traden
npm run run  -- <pool-address>      # öffnen + Hedge nachführen
npm run status                      # laufende Session
npm run close                       # alles auflösen

npm run backtest -- <pool>          # echte Historie durchspielen
npm run paper -- <pool>             # Live-Preise, simulierte Fills
npm run simulate -- <pool>          # Monte Carlo über viele Preispfade
npm run scenario -- <pool>          # "N Tage in Range, X% Fee-APR — was passiert?"
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

## 5. Strategie testen, bevor Geld fließt

Zwei Werkzeuge, die unterschiedliche Fragen beantworten.

### `npm run backtest -- <pool-address>`

Spielt **echte** Hyperliquid-Preis- und Funding-Historie durch die Strategie und
zerlegt das Ergebnis. Die Rebalancing-Entscheidungen kommen aus denselben
Funktionen wie im Live-Betrieb (`decideRebalance`, `planHedgeLeg`) — gemessen
wird also die Strategie wie implementiert, nicht ein zweites Modell davon.

```bash
npm run backtest -- <pool> --days=60 --interval=1h --on-exit=recenter
npm run backtest -- <pool> --fee-tvl=0.015 --csv=equity.csv
```

Was echt ist und was angenommen:

| Eingabe | Quelle |
|---------|--------|
| Preispfad | Hyperliquid-Candles (OHLC, intrabar durchlaufen) |
| Funding | Hyperliquid-Funding-Historie, echt gezahlte Raten |
| Bin-Step, Pool-Fee, Fees/TVL | Meteora-API für den angegebenen Pool |
| LP-Verhalten | Bin-Walk mit Meteoras eigener Verteilungsmathematik |
| Taker-Fees, Slippage, Gas | Parameter |
| **Fee-Einnahmen** | **die einzige echte Annahme** — Fees/TVL des Pools |

Der Report trennt das explizit. Die Fee-Annahme wird zusätzlich gegen eine harte
Untergrenze geprüft: das Arbitrage-Volumen, das der Preispfad *zwingend*
erzeugt hat. Steht die Annahme bei 2,5x davon, unterstellst du 2,5x
Noise-Flow obendrauf — prüf das gegen das echte Volumen des Pools.

### `npm run paper -- <pool-address>`

Live-Preise, simulierte Ausführung. Läuft den **echten** Entscheidungs-Loop
(`tick()`, dieselben Exit-Bedingungen) gegen simulierte Fills. Braucht keine
Keys, schreibt in einen eigenen State (`data/state.paper.json`), sendet nichts.

Ein Paper-Modus, der den Loop nachbaut, würde nur beweisen, dass der Nachbau
funktioniert. Deshalb sind LP- und Perp-Venue hinter schmalen Interfaces
([`src/strategy/venues.ts`](src/strategy/venues.ts)) austauschbar.

### `npm run simulate -- <pool-address>` — Monte Carlo

Ein einzelner Backtest sagt dir, was **einmal** passiert ist. Das hier sagt dir
die **Verteilung**, und nur die ist handlungsrelevant:

```bash
npm run simulate -- <pool> --paths=1000 --days=90 --vol=0.8
```

Die Preispfade sind synthetisch, aber nicht naiv: GARCH-Volatilitäts-Clustering
(ruhige und wilde Phasen statt gleichförmigem Rauschen) und Student-t-Tails
(Sprünge, die eine Normalverteilung nicht hergibt). Beides ist nötig, weil die
Strategie short Gamma *und* short Tails ist — reines GBM würde sie schönrechnen.

### Was die Tests ergeben haben

Fünf Befunde, jeder hat den Code oder die Doku verändert.

**1. Die Gamma-Kosten sind der Hauptgegner.** Über 1000 Pfade × 90 Tage bei 80%
Vola, ±5%-Range, 2%/Tag Fees:

```
                        p5        p25     median        p75        p95
Return auf Kapital  -29.67%    -12.77%     -2.59%     +6.79%    +17.62%
Max Drawdown         +3.77%     +7.23%    +12.31%    +19.21%    +36.13%
Breakeven Fee/Tag    +1.18%     +1.32%     +1.41%     +1.51%     +1.65%

Gewinnpfade: 42,7%   |   Hedge-Umsatz: 151x LP-Kapital   |   in range: 95,6%
```

**2. Die Slippage-Annahme entschied das Ergebnis — und war falsch gesetzt.**
Der Backtest nahm anfangs `HEDGE_SLIPPAGE_BPS=30` als *realisierte* Kosten. Das
ist aber die IOC-Limit-Aggressivität, also eine **Obergrenze für einen Fill**,
nicht der erwartete Preis. Bei 150x Umsatz macht das alles aus:

| angenommene Slippage | Gewinnpfade |
|---------------------|-------------|
| 30 bps | 8% |
| 10 bps | 31% |
| 3 bps (realistisch) | 48% |
| 1 bps | 52% |

Backtest und Simulation haben dafür jetzt einen eigenen Parameter
(`--slippage=3`), getrennt von der Order-Aggressivität.

**3. Range-Breite: fast egal für den Median, entscheidend für den Tail.**

Hier hatte ich zuerst ein falsches Ergebnis. Mein Modell gab jeder Range
dieselbe Fee-Rate — bei Concentrated Liquidity ist das falsch, eine engere Range
verdient pro Dollar proportional mehr. Damit gewannen breite Ranges künstlich
(+56% Median bei ±15%). Nach der Korrektur (`feeReferenceRangePct` skaliert die
Fee-Rate mit der Liquiditätsdichte):

| Range | eff. Fee/Tag | Median | p5 | Gewinnpfade | in range |
|-------|--------------|--------|-----|-------------|----------|
| ±2%  | 5,00% | +0,3% | -29,3% | 52% | 85% |
| ±5%  | 2,00% | -3,2% | -29,8% | 40% | 96% |
| ±10% | 1,00% | +0,6% | -21,6% | 52% | 99% |
| ±25% | 0,40% | +2,0% | **-6,8%** | **70%** | 100% |

Die Mehr-Fees einer engen Range werden vom Rebalancing und der Zeit außerhalb
der Range aufgefressen. Der Median ist überall ähnlich — aber der **schlechte
Fall ist bei einer weiten Range viermal milder**. Für eine gehebelte Position
ist das der Unterschied, der zählt.

**4. Die Rebalance-Schwelle begrenzt den Hedge-Fehler nicht.** Zwischen 1% und
10% war der maximale ungehedgte Betrag *identisch*. Der Bot kann nicht schneller
reagieren, als er beobachtet. **`POLL_INTERVAL_MS` ist der wichtigere Regler.**

**5. Der Hyperliquid-Account blutet in Trends aus.** Der teuerste Fund. In einer
Rally verliert der Short auf Hyperliquid, während der passende Gewinn in der
LP-Position auf Solana anfällt. Der Perp-Account leert sich, obwohl die
Gesamtposition gesund ist — und dann werden Hedge-Orders mangels Margin
abgelehnt. Der Backtest hat das anfangs still geschluckt (961 abgelehnte Orders,
bis zu 853 $ ungehedgtes Delta) und trotzdem eine hübsche Zahl gedruckt.

Konsequenzen:
- Der Backtest zählt fehlgeschlagene Hedges und setzt bei >0 ein
  **`!! RESULT NOT TRUSTWORTHY !!`** über den Report. Eine Zahl aus einem
  ungehedgten Zeitraum ist eine Richtungswette, keine Strategie.
- Er modelliert Margin-Transfers von der LP- zur Perp-Seite, weil genau das im
  echten Betrieb nötig ist.
- Der Live-Bot behandelt eine nicht ausgeführte Hedge-Order als Risiko-Ereignis
  (`TickReport.hedgeDegraded`, Error-Log mit dem exponierten Betrag).

### "Der Kursgewinn deckt doch den Short-Verlust" — die Rechnung dazu

Eine naheliegende Überlegung: Die LP-Position verdient täglich Fees; steigt der
Preis, macht sie *zusätzlich* einen Kursgewinn, der den Short-Verlust teilweise
deckt; bei genug Fees bleibt unterm Strich etwas übrig.

Die erste Hälfte stimmt, die zweite nicht — und zwar an einer Stelle, die alles
entscheidet. Der Hedge ist **auf das Delta dimensioniert**. LP-Kursgewinn und
Short-Verlust decken sich deshalb nicht *teilweise*, sondern **fast exakt, per
Konstruktion, in beide Richtungen**. Wäre der LP-Gewinn größer als der
Short-Verlust, wärst du nicht delta-neutral, sondern netto long.

`npm run scenario` macht das sichtbar. 14 Tage, ±13% Range, 50% Fee-APR,
10.000 $, glatter Preisverlauf ohne Schwankung:

```
Preis am Ende         LP Preis      Short    = Summe       Fees     Kosten      Netto
Range-Top (+13%)      +$309.30   -$321.94    -$12.64   +$195.79     -$8.52   +$182.15
unverändert (0%)        +$0.00    +$13.09    +$13.09   +$191.78     -$8.27   +$203.87
Range-Boden (-13%)   -$1014.07  +$1008.85     -$5.21   +$161.40    -$15.11   +$155.19
```

Die Spalte **`= Summe`** ist der Punkt: ±13 $ auf 10.000 $ Kapital. Der Preis
hebt sich raus, egal wohin er läuft. **Der gesamte Ertrag sind die Fees.**

Und der LP-Kursgewinn ist kleiner, als die Intuition sagt. Bei +13%:

| | LP-Wert | einfach Halten | Differenz |
|---|---------|----------------|-----------|
| +13% | 10.309 $ | 10.650 $ | -341 $ |

Halten würde +6,5% bringen (halbes Kapital × 13%), die LP-Position bringt +3,1%.
Also nicht „die Hälfte des Kursgewinns", sondern **etwa die Hälfte davon nochmal**
— weil die Position auf dem Weg nach oben laufend verkauft. Genau deshalb ist
auch der nötige Short kleiner als die volle Position, und genau deshalb geht die
Rechnung auf.

**Der Preis der Neutralität** ist der Rest: Der LP verkauft in die Rally hinein
zu Bin-Preisen, die der Markt schon passiert hat, und der Hedge kauft dieselbe
Position zum Marktpreis zurück. Diese Lücke, bei jeder Bin-Überquerung bezahlt,
ist Loss-versus-Rebalancing. Sie ist immer negativ.

### Welchen Fee-APR brauchst du also?

Hier ist eine Falle eingebaut, in die ich beim ersten Anlauf selbst getappt bin.
Man kann die Breakeven-Schwelle **nicht** direkt gegen den quotierten Pool-APR
halten, denn beide hängen von der Range-Breite ab. Wer breiter liegt, braucht
weniger — verdient aber auch weniger.

Der Pool quotiert seinen APR über die *durchschnittliche* Liquiditätsverteilung.
Liegst du enger, verdienst du proportional mehr; liegst du breiter, weniger. Bei
einem Pool mit 50% APR (Referenz ±10%) verdienst du bei ±W% also `50% × 10/W`:

**BTC, 42% Vola, 300 Pfade je Zeile:**

| Range | verdient | nötig | Verhältnis | Median 90d | p5 |
|-------|----------|-------|------------|------------|-----|
| ±5%  | 100% | 206% | 0,49 | -13,1% | -29,4% |
| ±10% | 50%  | 91%  | 0,55 | -4,8%  | -15,9% |
| ±15% | 33%  | 55%  | 0,61 | -1,9%  | -8,8% |
| ±20% | 25%  | 38%  | 0,66 | -0,7%  | -4,3% |
| ±25% | 20%  | 27%  | 0,73 | -0,4%  | -3,2% |
| ±35% | 14%  | 17%  | 0,84 | -0,1%  | -2,2% |

**Kein Verhältnis erreicht 1,0.** Bei 50% Pool-APR verliert die Strategie auf BTC
in jeder Breite. Dass die Zahlen mit der Breite gegen Null laufen, ist kein
Gewinn — man macht nur *weniger von einem Verlustgeschäft*. Im Grenzfall ±∞
liegt das Kapital praktisch brach.

Bei volatileren Assets wird es schlechter, und die Breite hilft dort **gar
nicht** mehr:

| Asset | ±5% | ±10% | ±20% | ±35% |
|-------|-----|------|------|------|
| BTC 42% | 0,49 | 0,55 | 0,66 | 0,84 |
| ETH 55% | 0,30 | 0,30 | 0,34 | 0,40 |
| SOL 80% | 0,19 | 0,15 | 0,14 | 0,16 |

**Die eigentliche Erkenntnis:** Weil verdiente *und* benötigte Fees beide grob
mit `1/Breite` skalieren, ist das Verhältnis über die Breiten **fast flach**.
Die Range-Breite ist ein Hebel zweiter Ordnung. Erster Ordnung ist das
Verhältnis von **Fee-Rate zu Volatilität** — und das rettet keine Range-Wahl.

Was du wirklich brauchst: einen Pool, dessen Fee-Rate die Schwelle bei einer
*nutzbaren* Breite schlägt. Für BTC/USDC heißt das grob **70–80% quotierter
APR** statt der 40–50%, die du genannt hast. Für SOL/USDC liegt die Latte bei
einem Vielfachen und ist realistisch kaum zu erreichen.

### Und das Funding?

Kaum relevant. Über die gesamte plausible Bandbreite bewegt es das Ergebnis um
gut einen Prozentpunkt über 90 Tage (BTC, ±20%):

| Funding-APR | Median 90d |
|-------------|------------|
| +20% (Longs zahlen) | -0,4% |
| +11% (typisch) | -0,7% |
| 0% | -1,2% |
| -11% (Shorts zahlen) | -1,6% |

Zur Klarstellung, weil das oft andersherum vermutet wird: Funding ist in Krypto
meist **positiv**, Longs zahlen Shorts. Der Hedge *verdient* also normalerweise
Funding. Rückenwind — aber gegen die Gamma-Kosten ein Rundungsfehler.

> **Wie belastbar ist das?** Das Fee-Konzentrationsmodell ist linear
> (`Fee-Rate ∝ 1/Breite`). Real hängt dein Volumenanteil davon ab, wie die
> übrige Pool-Liquidität verteilt ist, und Volumen konzentriert sich näher am
> Spot — die echte Beziehung könnte in beide Richtungen abweichen. Was
> robust bleibt: verdiente und benötigte Fees skalieren *gleichsinnig* mit der
> Breite, das Verhältnis ist deshalb flach. Diese Struktur trägt, die
> Nachkommastellen nicht.

### Welchen Pool nehmen?

Der Bot akzeptiert per Default nur Pools mit **Stablecoin-Quote**
(`REQUIRE_STABLE_QUOTE=true`) — also genau ein Short pro Position. Ein
Crypto/Crypto-Pool wie JUP/SOL trägt Delta auf beiden Seiten und bräuchte zwei
Perp-Positionen: zwei Margin-Töpfe, zwei Liquidationspreise, korreliert. Der Bot
kann das (`REQUIRE_STABLE_QUOTE=false`), aber es ist mehr Angriffsfläche für
wenig Gegenwert.

Innerhalb der Stable-Pools entscheidet die **Volatilität des Basis-Assets**,
nicht die Fees/TVL-Ratio. 400 Pfade × 90 Tage, ±10% Range, 3 bps Slippage:

| Pool | ang. Vola | Fees 1%/Tag | | Fees 2%/Tag | | Breakeven |
|------|-----------|-------------|---|-------------|---|-----------|
| | | Median | Gewinn | Median | Gewinn | pro Tag |
| cbBTC/USDC | 42% | **+41,5%** | 99% | **+94,0%** | 100% | 0,23% |
| wETH/USDC | 55% | +29,4% | 98% | +79,9% | 100% | 0,43% |
| SOL/USDC | 80% | +0,8% | 53% | +38,8% | 98% | 0,90% |
| JUP/USDC | 110% | -28,9% | 0% | +2,4% | 56% | 1,41% |
| WIF/USDC | 150% | -56,3% | 0% | -33,7% | 0% | 1,83% |

*(Vola-Werte sind angenommene Regime, keine Messung. Die Rangfolge ist der
Punkt, nicht die Nachkommastellen.)*

**BTC- und ETH-Pools sind mit Abstand die besten Kandidaten** — sie brauchen
0,23% bzw. 0,43% Fees/TVL pro Tag zum Break-Even, und solche Pools gibt es
regelmäßig. SOL ist der Grenzfall: bei 1%/Tag praktisch ein Münzwurf, bei 2%/Tag
gut. Memecoin-Pools verlieren zuverlässig, egal wie fett die Fees aussehen — bei
WIF gab es in 12 von 400 Pfaden sogar Liquidationen.

Das dreht die naive Fees/TVL-Rangliste um: der Pool mit 3%/Tag auf einem
Memecoin ist ein schlechteres Geschäft als der mit 0,8%/Tag auf cbBTC.

> **Noch nicht im `scan` abgebildet.** Die Rangliste sortiert nach Netto-APR
> inklusive Funding, aber ohne Vola-Abschlag. Bis das drin ist: nimm die
> `scan`-Ausgabe als Vorauswahl und prüf den Kandidaten mit
> `npm run simulate -- <pool> --vol=<geschätzte Vola>`.

### Wo die Strategie funktioniert

Zusammengefasst, bei realistischen 3 bps Slippage und weiter Range:

| Vola | Median | p5 | Gewinnpfade | Breakeven Fee/Tag |
|------|--------|-----|-------------|-------------------|
| 30%  | +90,6% | +80,5% | 100% | 0,06% |
| 50%  | +80,0% | +65,5% | 100% | 0,21% |
| 80%  | +56,4% | +32,8% | 100% | 0,61% |
| 120% | +15,3% | -14,4% | 83%  | 1,21% |
| 160% | -19,1% | -42,9% | 3%   | 1,63% |

*(bei ±15% Range mit unkorrigierter Fee-Skalierung — die Vola-Rangfolge bleibt
gültig, die absoluten Zahlen sind optimistisch; siehe Befund 3.)*

**Die Volatilität des Assets entscheidet, nicht die Fees/TVL-Ratio.** Ein Pool
mit 3%/Tag auf einem 160%-Vola-Memecoin verliert; einer mit 1%/Tag auf SOL bei
50% Vola gewinnt. Genau umgekehrt zur naiven Fees/TVL-Rangliste.

**Für den Betrieb heißt das:** plane Kapital ein, um Margin nachzuschieben, und
überwache das freie Collateral auf Hyperliquid. Der Bot transferiert **nicht**
selbst zwischen den Venues.

---

## 6. Ablauf & Reihenfolge

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

## 7. Sicherheits-Entscheidungen

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

## 8. Grenzen — bitte lesen

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

**Der Bot transferiert nicht zwischen den Venues.** Siehe Befund 3 oben: in
Trends muss Margin von der LP- zur Perp-Seite nachgeschoben werden. Der Bot
alarmiert, wenn ein Hedge nicht durchgeht, macht den Transfer aber nicht selbst.

**Die Backtest-Zahlen sind Modell, nicht Historie.** Beim `backtest` sind
Preispfad und Funding echt, die Fee-Einnahmen eine Annahme, und die Ausführung
unterstellt einen Fill bei Mark ± `--slippage`. Beim `simulate` sind zusätzlich
die Preispfade synthetisch — GARCH plus Fat Tails, aber ohne Trends,
Mean Reversion oder Korrelation mit dem Funding. Lies die Ausgabe als Bandbreite
plausibler Ergebnisse, nicht als Prognose.

**Die Fee-Skalierung über Range-Breiten ist ein grobes Modell.** `simulate`
skaliert die Fee-Rate linear mit der Liquiditätsdichte
(`feeReferenceRangePct / rangeWidthPct`). Real hängt der Anteil am Volumen davon
ab, wie die *übrige* Pool-Liquidität verteilt ist — das weiß der Bot nicht. Die
Rangfolge in der Tabelle ist belastbarer als die absoluten Zahlen.

**Nicht live gegen die Mainnet-APIs getestet.** Die Entwicklungsumgebung hatte keinen
Netzwerkzugang zu `dlmm-api.meteora.ag` und `api.hyperliquid.xyz`. Alle SDK-Aufrufe
sind gegen die installierten Typdefinitionen von `@meteora-ag/dlmm@1.9.14` und
`@nktkas/hyperliquid@0.33.2` geschrieben und typgeprüft, und die gesamte Logik ist
offline durchgetestet (232 Tests) — aber **fahre zuerst `npm run paper`**, dann
`DRY_RUN=true`, dann einen kleinen Betrag.

---

## 9. Projektstruktur

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
  sim/
    lpPosition.ts        DLMM-Bin-Walk-Simulator
    broker.ts            Simuliertes Perp-Konto: Fills, Funding, Liquidation
    distribution.ts      Meteoras echte Verteilungsmathematik (offline nutzbar)
  backtest/
    data.ts              Hyperliquid-Candles und Funding-Historie
    runner.ts            Replay-Loop mit den Produktions-Entscheidungen
    report.ts            PnL-Zerlegung
    paths.ts             Synthetische Pfade: GARCH-Clustering, Fat Tails
    montecarlo.ts        Verteilung über viele Pfade statt eines Ergebnisses
    scenario.ts          Was-wäre-wenn: Aufhebung und Kosten nebeneinander
  paper/venues.ts        Live-Daten + simulierte Ausführung
  util/                  HTTP mit Retries, Balance-Prüfung
test/                    232 Offline-Tests
```

### Zur `meteora/sdk.ts`-Datei

`@meteora-ag/dlmm` hat zwei Packaging-Eigenheiten, die beide dort gekapselt sind:

1. Der ESM-Build (`dist/index.mjs`) macht einen Directory-Import in Anchors
   CJS-Dist, was Nodes ESM-Resolver mit `ERR_UNSUPPORTED_DIR_IMPORT` ablehnt. Der
   CJS-Build wird deshalb explizit über `createRequire` geladen.
2. Eine `.d.ts` bedient beide Builds, wodurch ein Default-Import als Modul-Namespace
   statt als Klasse typisiert wird — der Konstruktor liegt eine Ebene tiefer.

---

## 10. Entwicklung

```bash
npm test          # 232 Offline-Tests, kein Netzwerk nötig
npm run typecheck # tsc --noEmit
npm run build     # -> dist/
```

Abgedeckt: die Mathematik (Delta, Liquidation, Leverage-Solve, Rebalancing-
Vorzeichen), die Bin-Geometrie, der komplette Selektions- und Planungspfad, die
Simulatoren, der Backtest-Runner — und der **echte Engine-Loop** end-to-end mit
gestubbten Venues (`test/engine.test.ts`), inklusive der Fehlerpfade: Hedge
scheitert, LP-Open scheitert, Position verschwunden, Collateral leer.

## Lizenz

MIT
