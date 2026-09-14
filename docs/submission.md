# Submission — hackathons.solana.com

**Project name:** StockSpend

**Tagline:** Spend your stocks. Keep your stocks.

**Description (paste into the form):**

Tokenized stocks already trade on Solana, but owning them still works like a brokerage app: to use the value you have to sell. StockSpend turns a stock portfolio into spendable money without selling. You deposit xStocks (TSLAx, AAPLx) as collateral, and whenever you pay a Solana Pay merchant the app borrows the USDC you're short and settles the payment in a single transaction. No sale, no taxable event, no lost upside: your shares stay yours.

What's built and working end to end (devnet):
- Anchor program: deposit / withdraw / borrow / repay with per-market LTV checks, Pyth PriceUpdateV2 oracle with a mock fallback, 14 passing tests (including the real Pyth price path via a cloned devnet account)
- Solana Pay transaction request endpoint: any wallet scans a standard QR and receives one transaction with borrow + transfer, tagged with the merchant reference
- Checkout inside Phantom's browser where the payer picks which stock backs the purchase
- Merchant page with QR generation and live payment detection
- Live prices from the Jupiter price API for the xStocks tokens (24/7), refreshed on demand

Why Solana: xStocks are plain SPL tokens, so collateral is just a token transfer; a borrow + payment settles in under a second for a fraction of a cent; and Solana Pay means every merchant already accepting USDC can accept a stock-backed payment today, with no integration.

Next: liquidations and interest, Pyth Crypto.TSLAX/USD feeds once entitled, real xStocks on mainnet, a debit card rail.

**Links:**
- GitHub: https://github.com/mariocana/stockspend
- Live demo: https://stockspend-production.up.railway.app
- Video: https://youtu.be/2l54QoZQWtg

**Track:** Consumer (mobile-first investing, spending from a portfolio) — also touches Credit.
