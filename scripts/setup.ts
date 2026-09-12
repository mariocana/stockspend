import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { Stockspend } from "../target/types/stockspend";
import idl from "../target/idl/stockspend.json";

const LTV_BPS = 5000;
const EQUITY_MAX_AGE = 72 * 60 * 60;
const ZERO_FEED = new Array(32).fill(0);

const STOCKS = [
  { symbol: "TSLAx", name: "Tesla", feed: "16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1", mockPrice: 413.35 },
  { symbol: "AAPLx", name: "Apple", feed: "49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688", mockPrice: 301.81 },
];

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = new Program(idl as Stockspend, provider);
  const admin = provider.wallet as anchor.Wallet;
  const conn = provider.connection;
  const url = conn.rpcEndpoint;
  const oracle = process.env.ORACLE ?? (url.includes("127.0.0.1") || url.includes("localhost") ? "mock" : "pyth");
  console.log(`cluster ${url} · oracle ${oracle} · admin ${admin.publicKey.toBase58()}`);

  const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
  const usdcMint = await createMint(conn, admin.payer, config, null, 6);
  const treasury = getAssociatedTokenAddressSync(usdcMint, config, true);

  await program.methods
    .initialize(LTV_BPS)
    .accountsPartial({
      admin: admin.publicKey,
      config,
      usdcMint,
      treasury,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log(`config ${config.toBase58()}`);
  console.log(`USDC ${usdcMint.toBase58()}`);

  const markets: Record<string, any> = {};
  for (const s of STOCKS) {
    const mint = await createMint(conn, admin.payer, config, null, 8);
    const [market] = PublicKey.findProgramAddressSync([Buffer.from("market"), mint.toBuffer()], program.programId);
    const vault = getAssociatedTokenAddressSync(mint, market, true);
    const feed = oracle === "pyth" ? Array.from(Buffer.from(s.feed, "hex")) : ZERO_FEED;
    await program.methods
      .createMarket(feed, new BN(EQUITY_MAX_AGE), new BN(Math.round(s.mockPrice * 1e6)))
      .accountsPartial({
        admin: admin.publicKey,
        config,
        stockMint: mint,
        market,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    markets[s.symbol] = { name: s.name, mint: mint.toBase58(), market: market.toBase58(), feedId: oracle === "pyth" ? s.feed : null };
    console.log(`${s.symbol} mint ${mint.toBase58()} market ${market.toBase58()}`);
  }

  await program.methods
    .mintMock(new BN(1_000_000 * 1e6))
    .accountsPartial({
      signer: admin.publicKey,
      config,
      mint: usdcMint,
      destination: getAssociatedTokenAddressSync(usdcMint, admin.publicKey),
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  await program.methods
    .fundTreasury(new BN(1_000_000 * 1e6))
    .accountsPartial({
      funder: admin.publicKey,
      config,
      usdcMint,
      treasury,
      funderUsdc: getAssociatedTokenAddressSync(usdcMint, admin.publicKey),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  console.log("treasury funded with 1,000,000 USDC");

  const out = {
    cluster: url,
    programId: program.programId.toBase58(),
    config: config.toBase58(),
    usdcMint: usdcMint.toBase58(),
    treasury: treasury.toBase58(),
    ltvBps: LTV_BPS,
    markets,
  };
  const dir = path.join(__dirname, "..", "app", "src", "lib");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "addresses.json"), JSON.stringify(out, null, 2));
  fs.copyFileSync(path.join(__dirname, "..", "target", "idl", "stockspend.json"), path.join(dir, "idl.json"));
  console.log("wrote app/src/lib/addresses.json and idl.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
