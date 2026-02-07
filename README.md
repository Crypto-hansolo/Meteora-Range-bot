# Meteora DLMM Copy Trading Bot

Ein produktionsnaher Copy-Trading-Bot für Solana, der Meteora DLMM Positionen von Ziel-Wallets 1:1 spiegelt. Der Bot beobachtet die Ziel-Wallets, erkennt DLMM-Transaktionen und repliziert diese Aktionen über den Meteora SDK-Adapter.

## Features

- Mehrere Ziel-Wallets parallel beobachten
- Zustandsverwaltung (letzte verarbeitete Signatur)
- Dry-Run Modus zum Testen ohne echte Trades
- SDK-Adapter für Meteora DLMM mit klaren Erweiterungspunkten

## Voraussetzungen

- Node.js 18+
- Zugriff auf einen Solana RPC-Endpoint (HTTPS + WSS)
- Payer-Wallet mit SOL für Gebühren
- Meteora DLMM SDK (`@meteora-ag/dlmm`)

## Installation

```bash
npm install
```

## Konfiguration

Erstelle eine `.env` Datei basierend auf `.env.example`:

```bash
cp .env.example .env
```

Pflichtfelder:

- `RPC_URL`
- `PAYER_SECRET_KEY` (Base58 Secret Key)
- `TARGET_WALLETS` (kommagetrennt)
- `METEORA_DLMM_PROGRAM_ID`

Optional:

- `WS_URL`
- `POLL_INTERVAL_MS`
- `DRY_RUN`
- `STATE_PATH`

## Starten

```bash
npm run dev
```

oder mit Build:

```bash
npm run build
npm start
```

## Anpassung des Meteora Adapters

Der Adapter in `src/meteora/adapter.ts` verwendet das Meteora SDK, um DLMM-Aktionen zu dekodieren und auszuführen. Falls sich die SDK-API unterscheidet, aktualisiere die Methoden:

- `decodeActions(...)`
- `executeAction(...)`

## Sicherheitshinweise

- Nutze zuerst `DRY_RUN=true`, um sicherzustellen, dass die Ziel-Transaktionen korrekt erkannt werden.
- Verwende ein dediziertes Wallet mit limitiertem Kapital.
- Überprüfe regelmäßig die Logs und den State.
