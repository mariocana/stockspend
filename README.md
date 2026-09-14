# StockSpend

**Spend your tokenized stock portfolio without selling it.**

Built for [Stocklana](https://hackathons.solana.com/hackathons/stocklana) (Sept 11–18, 2026).

Deposit tokenized stocks (xStocks) as collateral, borrow USDC against them, and pay
anywhere with Solana Pay — in one transaction. Your shares stay yours: no sale, no
taxable event, no lost upside.

## How it works

```
deposit(TSLAx) ──► Position { collateral, debt }
borrow(USDC)   ──► debt ≤ collateral × price × LTV
pay            ──► borrow + transfer in a single tx (Solana Pay)
repay / withdraw
```

## Program (Anchor)

| Instruction     | Who    | What                                             |
|-----------------|--------|--------------------------------------------------|
| `initialize`    | admin  | Global config + USDC treasury, sets LTV (bps)    |
| `create_market` | admin  | Registers a stock mint + vault, Pyth feed id, max price age |
| `update_price`  | admin  | Mock oracle, only for markets without a Pyth feed |
| `fund_treasury` | anyone | Adds USDC liquidity                              |
| `deposit`       | user   | Stock → vault, opens/updates Position            |
| `withdraw`      | user   | Vault → user, if position stays within LTV       |
| `borrow`        | user   | Treasury USDC → user, if within LTV              |
| `repay`         | user   | User USDC → treasury (capped at debt)            |

PDAs: `["config"]`, `["market", stock_mint]`, `["position", owner, market]`.
Prices are USD × 10⁶ per share; stock value = `amount × price / 10^decimals` in USDC base units.

### Devnet deployment

| | |
|---|---|
| Program | `HHUNGo3PrayWbGD3sFf8upkEpAJbF5oMvVGsYBGmc2zY` |
| Config | `GCAnj2FoCMX8MAF8d7rvfKxZM11yySinRQ9JZU84uSNs` |
| Mock USDC | `4UmhkHnwxaPW8H7aCp2Hi4cZjsmzf6wDQRDPp2WiNix4` |
| TSLAx (mock) | `HFTkTgf4HpQn1buNPtB4L31B9Z2S3p2s2xMPk5MtRhAZ` |
| AAPLx (mock) | `HWWd84YQPUfJHNvy2JJojc5JZttE1e2U1CoDdM5vo6v4` |

All addresses live in `app/src/lib/addresses.json`. The in-app faucet mints mock tokens to any wallet.

### Oracle

`borrow` and `withdraw` take an optional `price_update` account — a Pyth
[`PriceUpdateV2`](https://docs.pyth.network/price-feeds/use-real-time-data/solana)
for the market's `feed_id`, checked for feed match, full verification and age
(`max_price_age_secs`). A market created with an all-zero feed id is **mock-priced**
(admin sets the price via `update_price`) — used for local tests and the devnet faucet demo.

The right feeds for xStocks collateral are Pyth's `Crypto.TSLAX/USD` (`47a15647…`) and
`Crypto.AAPLX/USD` (`978e6cc6…`): they price the token itself and trade 24/7. Since the
August 2026 Pyth Core upgrade, Hermes requires an API key and those feeds are not in the
free tier, so the **devnet demo uses mock-priced markets pushed every 15 minutes from the
Jupiter price API** (`scripts/price-crank.ts`, run by GitHub Actions) with a 1h max age.
The Pyth path is implemented and tested: local tests clone Pyth's sponsored TSLA account
from devnet (`E8WFH8…`) to exercise it end to end, and `ORACLE=pyth npm run setup` creates
Pyth-priced markets given an entitled `PYTH_API_KEY`.

### v1 scope (hackathon)
- Fixed LTV, no interest, no liquidations, protocol treasury is the sole lender.

## Dev

```bash
anchor keys sync        # once, after generating the program keypair
anchor build
anchor test
```

### Devnet

```bash
anchor deploy --provider.cluster devnet
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com npm run setup
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com npm run crank      # EVERY=300 to loop
```

`.github/workflows/crank.yml` runs the crank every 15 minutes; it needs the `SOLANA_KEYPAIR`
secret (contents of the admin `id.json`) and optionally `RPC_URL` / `PYTH_API_KEY`.

GitHub's cron is best-effort, so the app also refreshes on demand: with `ADMIN_KEYPAIR`
(same JSON array) set on the server, `/api/refresh` pushes a fresh Jupiter price for any
mock market older than 20 minutes. The portfolio page, the checkout and `/api/pay` call it
before building a transaction, so a payment never fails on a stale price.

## Pay with portfolio (Solana Pay)

`/merchant` creates a payment request and shows a QR code. It is a Solana Pay
**transaction request** (`solana:https://<host>/api/pay?...`): the wallet POSTs the payer's
address, `/api/pay` reads their positions and returns a single transaction with
`borrow(shortfall)` from the market(s) with the most room + a USDC `transfer_checked` to the
merchant (tagged with the `reference` key so the merchant page can detect it).
`/checkout` is the same flow for the same device, signed with the connected wallet.

If the payer already holds enough USDC, no borrow is added. If the shortfall exceeds the
available LTV room, the request is refused with a clear message.

```bash
npx ts-node -P tsconfig.json scripts/pay-e2e.ts   # simulates a wallet hitting /api/pay
```

## App

```bash
anchor localnet                 # terminal 1
npm run setup                   # terminal 2, writes app/src/lib/{addresses,idl}.json
cd app && npm install && npm run dev
```

`npm run setup` reads `ANCHOR_PROVIDER_URL` / `ANCHOR_WALLET` (defaults to localnet + `~/.config/solana/id.json`)
and creates mock USDC/TSLAx/AAPLx mints (mint authority = config PDA, so anyone can use the in-app faucet),
initializes the protocol, creates the markets and funds the treasury. Set `ORACLE=pyth` to create
Pyth-priced markets (default on non-local clusters).

The app reads `NEXT_PUBLIC_RPC_URL` (falls back to the cluster in `addresses.json`).
