import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { assert, expect } from "chai";
import { Stockspend } from "../target/types/stockspend";

const USDC_DECIMALS = 6;
const STOCK_DECIMALS = 8; // xStocks use 8 decimals
const usdc = (n: number) => new BN(Math.round(n * 10 ** USDC_DECIMALS));
const shares = (n: number) => new BN(Math.round(n * 10 ** STOCK_DECIMALS));
const price = (usd: number) => new BN(Math.round(usd * 1e6));

describe("stockspend", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Stockspend as Program<Stockspend>;
  const admin = provider.wallet as anchor.Wallet;
  const conn = provider.connection;

  const user = Keypair.generate();
  let usdcMint: PublicKey;
  let tslaMint: PublicKey;
  let config: PublicKey;
  let treasury: PublicKey;
  let market: PublicKey;
  let vault: PublicKey;
  let position: PublicKey;
  let adminUsdc: PublicKey;
  let userUsdc: PublicKey;
  let userTsla: PublicKey;

  const LTV_BPS = 5000;
  const TSLA_PRICE = 250; // USD

  before(async () => {
    // fund user
    const sig = await conn.requestAirdrop(user.publicKey, 5 * anchor.web3.LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, "confirmed");

    usdcMint = await createMint(conn, admin.payer, admin.publicKey, null, USDC_DECIMALS);
    tslaMint = await createMint(conn, admin.payer, admin.publicKey, null, STOCK_DECIMALS);

    [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
    [market] = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), tslaMint.toBuffer()],
      program.programId
    );
    [position] = PublicKey.findProgramAddressSync(
      [Buffer.from("position"), user.publicKey.toBuffer(), market.toBuffer()],
      program.programId
    );
    treasury = getAssociatedTokenAddressSync(usdcMint, config, true);
    vault = getAssociatedTokenAddressSync(tslaMint, market, true);
    userUsdc = getAssociatedTokenAddressSync(usdcMint, user.publicKey);

    adminUsdc = (await getOrCreateAssociatedTokenAccount(conn, admin.payer, usdcMint, admin.publicKey)).address;
    userTsla = (await getOrCreateAssociatedTokenAccount(conn, admin.payer, tslaMint, user.publicKey)).address;

    await mintTo(conn, admin.payer, usdcMint, adminUsdc, admin.payer, usdc(1_000_000).toNumber());
    await mintTo(conn, admin.payer, tslaMint, userTsla, admin.payer, shares(10).toNumber());
  });

  it("initializes config and treasury", async () => {
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

    const cfg = await program.account.config.fetch(config);
    expect(cfg.admin.toBase58()).to.eq(admin.publicKey.toBase58());
    expect(cfg.ltvBps).to.eq(LTV_BPS);
  });

  it("creates the TSLA market", async () => {
    await program.methods
      .createMarket(price(TSLA_PRICE))
      .accountsPartial({
        admin: admin.publicKey,
        config,
        stockMint: tslaMint,
        market,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const m = await program.account.market.fetch(market);
    expect(m.decimals).to.eq(STOCK_DECIMALS);
    expect(m.price.toNumber()).to.eq(TSLA_PRICE * 1e6);
  });

  it("funds the treasury", async () => {
    await program.methods
      .fundTreasury(usdc(100_000))
      .accountsPartial({
        funder: admin.publicKey,
        config,
        usdcMint,
        treasury,
        funderUsdc: adminUsdc,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    expect(Number((await getAccount(conn, treasury)).amount)).to.eq(usdc(100_000).toNumber());
  });

  it("deposits 4 TSLA as collateral", async () => {
    await program.methods
      .deposit(shares(4))
      .accountsPartial({
        owner: user.publicKey,
        stockMint: tslaMint,
        market,
        vault,
        ownerStock: userTsla,
        position,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    const pos = await program.account.position.fetch(position);
    expect(pos.collateral.toString()).to.eq(shares(4).toString());
    expect(pos.debt.toNumber()).to.eq(0);
    expect(Number((await getAccount(conn, vault)).amount)).to.eq(shares(4).toNumber());
  });

  it("borrows 400 USDC (4 x $250 x 50% = $500 max)", async () => {
    await program.methods
      .borrow(usdc(400))
      .accountsPartial({
        owner: user.publicKey,
        config,
        usdcMint,
        treasury,
        ownerUsdc: userUsdc,
        market,
        position,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    const pos = await program.account.position.fetch(position);
    expect(pos.debt.toString()).to.eq(usdc(400).toString());
    expect(Number((await getAccount(conn, userUsdc)).amount)).to.eq(usdc(400).toNumber());
  });

  it("rejects borrowing beyond LTV", async () => {
    try {
      await program.methods
        .borrow(usdc(101))
        .accountsPartial({
          owner: user.publicKey,
          config,
          usdcMint,
          treasury,
          ownerUsdc: userUsdc,
          market,
          position,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();
      assert.fail("should have thrown");
    } catch (e: any) {
      expect(e.error?.errorCode?.code).to.eq("ExceedsLtv");
    }
  });

  it("rejects withdrawing collateral that backs the debt", async () => {
    try {
      await program.methods
        .withdraw(shares(1))
        .accountsPartial({
          owner: user.publicKey,
          config,
          stockMint: tslaMint,
          market,
          vault,
          ownerStock: userTsla,
          position,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user])
        .rpc();
      assert.fail("should have thrown");
    } catch (e: any) {
      expect(e.error?.errorCode?.code).to.eq("ExceedsLtv");
    }
  });

  it("price drop makes the position unable to borrow more", async () => {
    await program.methods
      .updatePrice(price(100))
      .accountsPartial({ admin: admin.publicKey, config, market })
      .rpc();

    try {
      await program.methods
        .borrow(usdc(1))
        .accountsPartial({
          owner: user.publicKey,
          config,
          usdcMint,
          treasury,
          ownerUsdc: userUsdc,
          market,
          position,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();
      assert.fail("should have thrown");
    } catch (e: any) {
      expect(e.error?.errorCode?.code).to.eq("ExceedsLtv");
    }

    await program.methods
      .updatePrice(price(TSLA_PRICE))
      .accountsPartial({ admin: admin.publicKey, config, market })
      .rpc();
  });

  it("repays in full (overpayment is capped) and withdraws everything", async () => {
    await program.methods
      .repay(usdc(999))
      .accountsPartial({
        owner: user.publicKey,
        config,
        usdcMint,
        treasury,
        ownerUsdc: userUsdc,
        market,
        position,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user])
      .rpc();

    let pos = await program.account.position.fetch(position);
    expect(pos.debt.toNumber()).to.eq(0);
    expect(Number((await getAccount(conn, userUsdc)).amount)).to.eq(0);

    await program.methods
      .withdraw(shares(4))
      .accountsPartial({
        owner: user.publicKey,
        config,
        stockMint: tslaMint,
        market,
        vault,
        ownerStock: userTsla,
        position,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user])
      .rpc();

    pos = await program.account.position.fetch(position);
    expect(pos.collateral.toNumber()).to.eq(0);
    expect(Number((await getAccount(conn, userTsla)).amount)).to.eq(shares(10).toNumber());
  });
});
