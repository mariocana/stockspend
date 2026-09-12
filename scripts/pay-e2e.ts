import * as anchor from "@coral-xyz/anchor";
import { Program, BN, Idl } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
import idl from "../app/src/lib/idl.json";
import addresses from "../app/src/lib/addresses.json";

const APP = process.env.APP_URL ?? "http://localhost:3000";
const AMOUNT = 4.5;

async function main() {
  const provider = anchor.AnchorProvider.env();
  const conn = provider.connection;
  const customer = Keypair.generate();
  const merchant = Keypair.generate().publicKey;
  const reference = Keypair.generate().publicKey;
  try {
    await conn.confirmTransaction(await conn.requestAirdrop(customer.publicKey, 2 * LAMPORTS_PER_SOL), "confirmed");
  } catch {
    const fund = new Transaction().add(SystemProgram.transfer({ fromPubkey: provider.wallet.publicKey, toPubkey: customer.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL }));
    await provider.sendAndConfirm(fund);
  }

  const wallet = new anchor.Wallet(customer);
  const program = new Program(idl as Idl, new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" }));
  const config = new PublicKey(addresses.config);
  const usdcMint = new PublicKey(addresses.usdcMint);
  const tsla = addresses.markets.TSLAx;
  const mint = new PublicKey(tsla.mint);
  const market = new PublicKey(tsla.market);
  const [position] = PublicKey.findProgramAddressSync([Buffer.from("position"), customer.publicKey.toBuffer(), market.toBuffer()], program.programId);

  await program.methods
    .mintMock(new BN(1e8))
    .accountsPartial({ signer: customer.publicKey, config, mint, destination: getAssociatedTokenAddressSync(mint, customer.publicKey), tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
    .rpc();
  await program.methods
    .deposit(new BN(1e8))
    .accountsPartial({ owner: customer.publicKey, stockMint: mint, market, vault: getAssociatedTokenAddressSync(mint, market, true), ownerStock: getAssociatedTokenAddressSync(mint, customer.publicKey), position, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
    .rpc();
  console.log("customer holds 1 TSLAx as collateral, 0 USDC");

  const q = new URLSearchParams({ recipient: merchant.toBase58(), amount: String(AMOUNT), reference: reference.toBase58(), label: "e2e coffee" });
  const get: any = await fetch(`${APP}/api/pay?${q}`).then((r) => r.json());
  console.log("GET  /api/pay →", get);
  const post: any = await fetch(`${APP}/api/pay?${q}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: customer.publicKey.toBase58() }) }).then((r) => r.json());
  if (!post.transaction) throw new Error("POST failed: " + JSON.stringify(post));
  console.log("POST /api/pay →", post.message);

  const tx = Transaction.from(Buffer.from(post.transaction, "base64"));
  console.log(`transaction has ${tx.instructions.length} instructions`);
  tx.sign(customer);
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, "confirmed");
  console.log("sent", sig);

  const merchantUsdc = await getAccount(conn, getAssociatedTokenAddressSync(usdcMint, merchant, true));
  const pos: any = await (program.account as any).position.fetch(position);
  const sigs = await conn.getSignaturesForAddress(reference, { limit: 1 }, "confirmed");
  console.log(`merchant received ${Number(merchantUsdc.amount) / 1e6} USDC`);
  console.log(`customer debt ${pos.debt.toNumber() / 1e6} USDC, collateral ${pos.collateral.toNumber() / 1e8} TSLAx`);
  console.log(`reference lookup finds tx: ${sigs[0]?.signature === sig}`);
  if (Number(merchantUsdc.amount) !== AMOUNT * 1e6 || pos.debt.toNumber() !== AMOUNT * 1e6) throw new Error("mismatch");
  console.log("OK");
}

main().catch((e) => { console.error(e); process.exit(1); });
