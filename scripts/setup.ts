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
const MAX_PRICE_AGE = 60 * 60;
const ZERO_FEED = new Array(32).fill(0);

const STOCKS = [
  {
    symbol: "TSLAx",
    name: "Tesla xStock",
    feed: "47a156470288850a440df3a6ce85a55917b813a19bb5b31128a33a986566a362",
    mainnetMint: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB",
    mockPrice: 367.8,
  },
  {
    symbol: "AAPLx",
    name: "Apple xStock",
    feed: "978e6cc68a119ce066aa830017318563a9ed04ec3a0a6439010fc11296a58675",
    mainnetMint: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp",
    mockPrice: 332.7,
  },
];

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = new Program(idl as Stockspend, provider);
  const admin = provider.wallet as anchor.Wallet;
  const conn = provider.connection;
  const url = conn.rpcEndpoint;
  const oracle = process.env.ORACLE ?? "jupiter";
  console.log(`cluster ${url} · oracle ${oracle} · admin ${admin.publicKey.toBase58()}`);

  const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
  const existing: any = await (program.account as any).config.fetchNullable(config);
  let usdcMint: PublicKey;
  if (existing) {
    usdcMint = existing.usdcMint;
    console.log(`config ${config.toBase58()} already initialized, reusing USDC ${usdcMint.toBase58()}`);
  } else {
    usdcMint = await createMint(conn, admin.payer, config, null, 6);
    await program.methods
      .initialize(LTV_BPS)
      .accountsPartial({
        admin: admin.publicKey,
        config,
        usdcMint,
        treasury: getAssociatedTokenAddressSync(usdcMint, config, true),
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(`config ${config.toBase58()}`);
    console.log(`USDC ${usdcMint.toBase58()}`);
  }
  const treasury = getAssociatedTokenAddressSync(usdcMint, config, true);

  const markets: Record<string, any> = {};
  for (const s of STOCKS) {
    const mint = await createMint(conn, admin.payer, config, null, 8);
    const [market] = PublicKey.findProgramAddressSync([Buffer.from("market"), mint.toBuffer()], program.programId);
    const vault = getAssociatedTokenAddressSync(mint, market, true);
    const feed = oracle === "pyth" ? Array.from(Buffer.from(s.feed, "hex")) : ZERO_FEED;
    await program.methods
      .createMarket(feed, new BN(MAX_PRICE_AGE), new BN(Math.round(s.mockPrice * 1e6)))
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
    markets[s.symbol] = {
      name: s.name,
      mint: mint.toBase58(),
      market: market.toBase58(),
      feedId: oracle === "pyth" ? s.feed : null,
      mainnetMint: s.mainnetMint,
      source: oracle === "pyth" ? "pyth" : "jupiter",
    };
    console.log(`${s.symbol} mint ${mint.toBase58()} market ${market.toBase58()}`);
  }

  const funding = Number(process.env.TREASURY_USDC ?? 1_000_000);
  await program.methods
    .mintMock(new BN(funding * 1e6))
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
    .fundTreasury(new BN(funding * 1e6))
    .accountsPartial({
      funder: admin.publicKey,
      config,
      usdcMint,
      treasury,
      funderUsdc: getAssociatedTokenAddressSync(usdcMint, admin.publicKey),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  console.log(`treasury funded with ${funding.toLocaleString("en-US")} USDC`);

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
