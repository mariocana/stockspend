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

const MOCK_FEED_ID = new Array(32).fill(0);
const feedId = (hex: string) => Array.from(Buffer.from(hex, "hex"));
// Pyth Equity.US.TSLA/USD
const TSLA_FEED_HEX = "16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1";
// Pyth's sponsored push-oracle account for that feed (cloned from devnet, see Anchor.toml)
const TSLA_PRICE_UPDATE = new PublicKey("E8WFH8brgP58arcuW2wwsPHiomYrSvrgWTsRLZLAEZUQ");
const ONE_DAY = 24 * 60 * 60;

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
  const TSLA_PRICE = 250; // USD (mock market)

  const borrowAccounts = (extra: Partial<Record<string, PublicKey | null>> = {}) => ({
    owner: user.publicKey,
    config,
    usdcMint,
    treasury,
    ownerUsdc: userUsdc,
    market,
    position,
    priceUpdate: null,
    tokenProgram: TOKEN_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
    ...extra,
  });
  const withdrawAccounts = () => ({
    owner: user.publicKey,
    config,
    stockMint: tslaMint,
    market,
    vault,
    ownerStock: userTsla,
    position,
    priceUpdate: null,
    tokenProgram: TOKEN_PROGRAM_ID,
  });

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
      .createMarket(MOCK_FEED_ID, new BN(ONE_DAY), price(TSLA_PRICE))
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

  it("faucet caps non-admin mints and lets admin mint freely", async () => {
    const faucetMint = await createMint(conn, admin.payer, config, null, STOCK_DECIMALS);
    const call = (signer: Keypair | anchor.Wallet, amount: BN) =>
      program.methods
        .mintMock(amount)
        .accountsPartial({
          signer: signer.publicKey,
          config,
          mint: faucetMint,
          destination: getAssociatedTokenAddressSync(faucetMint, signer.publicKey),
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers(signer instanceof Keypair ? [signer] : [])
        .rpc();

    try {
      await call(user, shares(11));
      assert.fail("should have thrown");
    } catch (e: any) {
      expect(e.error?.errorCode?.code).to.eq("FaucetCapExceeded");
    }
    await call(user, shares(10));
    await call(admin, shares(1000));
    const userAta = getAssociatedTokenAddressSync(faucetMint, user.publicKey);
    expect(Number((await getAccount(conn, userAta)).amount)).to.eq(shares(10).toNumber());
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
      .accountsPartial(borrowAccounts())
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
        .accountsPartial(borrowAccounts())
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
        .accountsPartial(withdrawAccounts())
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
        .accountsPartial(borrowAccounts())
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
      .accountsPartial(withdrawAccounts())
      .signers([user])
      .rpc();

    pos = await program.account.position.fetch(position);
    expect(pos.collateral.toNumber()).to.eq(0);
    expect(Number((await getAccount(conn, userTsla)).amount)).to.eq(shares(10).toNumber());
  });

  describe("pyth-priced market", () => {
    const pythMint = Keypair.generate();
    let pMarket: PublicKey, pVault: PublicKey, pPosition: PublicKey, userPyth: PublicKey;

    const setupMarket = async (mint: PublicKey, maxAge: number) => {
      const [m] = PublicKey.findProgramAddressSync([Buffer.from("market"), mint.toBuffer()], program.programId);
      const v = getAssociatedTokenAddressSync(mint, m, true);
      await program.methods
        .createMarket(feedId(TSLA_FEED_HEX), new BN(maxAge), new BN(0))
        .accountsPartial({
          admin: admin.publicKey,
          config,
          stockMint: mint,
          market: m,
          vault: v,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      return { m, v };
    };

    before(async () => {
      const mint = await createMint(conn, admin.payer, admin.publicKey, null, STOCK_DECIMALS, pythMint);
      // 1 year: the cloned devnet account is months old, we still want to exercise the price path
      ({ m: pMarket, v: pVault } = await setupMarket(mint, 365 * ONE_DAY));
      [pPosition] = PublicKey.findProgramAddressSync(
        [Buffer.from("position"), user.publicKey.toBuffer(), pMarket.toBuffer()],
        program.programId
      );
      userPyth = (await getOrCreateAssociatedTokenAccount(conn, admin.payer, mint, user.publicKey)).address;
      await mintTo(conn, admin.payer, mint, userPyth, admin.payer, shares(2).toNumber());

      await program.methods
        .deposit(shares(2))
        .accountsPartial({
          owner: user.publicKey,
          stockMint: mint,
          market: pMarket,
          vault: pVault,
          ownerStock: userPyth,
          position: pPosition,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();
    });

    it("rejects update_price on a pyth market", async () => {
      try {
        await program.methods
          .updatePrice(price(1))
          .accountsPartial({ admin: admin.publicKey, config, market: pMarket })
          .rpc();
        assert.fail("should have thrown");
      } catch (e: any) {
        expect(e.error?.errorCode?.code).to.eq("NotMockMarket");
      }
    });

    it("requires the price update account", async () => {
      try {
        await program.methods
          .borrow(usdc(1))
          .accountsPartial(borrowAccounts({ market: pMarket, position: pPosition, priceUpdate: null }))
          .signers([user])
          .rpc();
        assert.fail("should have thrown");
      } catch (e: any) {
        expect(e.error?.errorCode?.code).to.eq("MissingPriceUpdate");
      }
    });

    it("borrows up to LTV using the on-chain Pyth price", async () => {
      // read the cloned account to compute the expected limit independently
      const raw = (await conn.getAccountInfo(TSLA_PRICE_UPDATE))!.data;
      const vlLen = raw[40] === 1 ? 1 : 2;
      const off = 8 + 32 + vlLen + 32;
      const p = Number(raw.readBigInt64LE(off));
      const expo = raw.readInt32LE(off + 16);
      const priceUsdMicro = Math.floor(p * 10 ** (expo + 6));
      const maxDebt = Math.floor((2 * priceUsdMicro * LTV_BPS) / 10_000);

      // just above the limit fails...
      try {
        await program.methods
          .borrow(new BN(maxDebt + 1))
          .accountsPartial(borrowAccounts({ market: pMarket, position: pPosition, priceUpdate: TSLA_PRICE_UPDATE }))
          .signers([user])
          .rpc();
        assert.fail("should have thrown");
      } catch (e: any) {
        expect(e.error?.errorCode?.code).to.eq("ExceedsLtv");
      }

      // ...exactly the limit succeeds
      await program.methods
        .borrow(new BN(maxDebt))
        .accountsPartial(borrowAccounts({ market: pMarket, position: pPosition, priceUpdate: TSLA_PRICE_UPDATE }))
        .signers([user])
        .rpc();
      const pos = await program.account.position.fetch(pPosition);
      expect(pos.debt.toNumber()).to.eq(maxDebt);
    });

    it("rejects a stale price when max age is tight", async () => {
      const mint = await createMint(conn, admin.payer, admin.publicKey, null, STOCK_DECIMALS);
      const { m, v } = await setupMarket(mint, 60);
      const [pos] = PublicKey.findProgramAddressSync(
        [Buffer.from("position"), user.publicKey.toBuffer(), m.toBuffer()],
        program.programId
      );
      const ata = (await getOrCreateAssociatedTokenAccount(conn, admin.payer, mint, user.publicKey)).address;
      await mintTo(conn, admin.payer, mint, ata, admin.payer, shares(1).toNumber());
      await program.methods
        .deposit(shares(1))
        .accountsPartial({
          owner: user.publicKey,
          stockMint: mint,
          market: m,
          vault: v,
          ownerStock: ata,
          position: pos,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      try {
        await program.methods
          .borrow(usdc(1))
          .accountsPartial(borrowAccounts({ market: m, position: pos, priceUpdate: TSLA_PRICE_UPDATE }))
          .signers([user])
          .rpc();
        assert.fail("should have thrown");
      } catch (e: any) {
        expect(e.error?.errorCode?.code).to.eq("StalePrice");
      }
    });
  });
});
