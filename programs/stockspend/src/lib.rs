//! StockSpend — borrow USDC against tokenized stocks and spend it, without selling.

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{self, Mint, MintTo, TokenAccount, TokenInterface, TransferChecked},
};
use pyth_solana_receiver_sdk::{error::GetPriceError, price_update::{FeedId, PriceUpdateV2}};

declare_id!("HHUNGo3PrayWbGD3sFf8upkEpAJbF5oMvVGsYBGmc2zY");

pub const BPS: u64 = 10_000;
/// Prices are stored as USD * 10^6, i.e. directly in USDC base units per whole share.
pub const PRICE_DECIMALS: u8 = 6;
/// Mock oracle
pub const MOCK_FEED_ID: FeedId = [0u8; 32];

pub const FAUCET_CAP_SHARES: u64 = 10;
pub const FAUCET_CAP_USDC: u64 = 10_000;

pub const CONFIG_SEED: &[u8] = b"config";
pub const MARKET_SEED: &[u8] = b"market";
pub const POSITION_SEED: &[u8] = b"position";

#[program]
pub mod stockspend {
    use super::*;

    /// One-time setup: global config + USDC treasury owned by the config PDA.
    pub fn initialize(ctx: Context<Initialize>, ltv_bps: u16) -> Result<()> {
        require!(ltv_bps > 0 && (ltv_bps as u64) < BPS, StockSpendError::InvalidLtv);
        let cfg = &mut ctx.accounts.config;
        cfg.admin = ctx.accounts.admin.key();
        cfg.usdc_mint = ctx.accounts.usdc_mint.key();
        cfg.treasury = ctx.accounts.treasury.key();
        cfg.ltv_bps = ltv_bps;
        cfg.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn create_market(
        ctx: Context<CreateMarket>,
        feed_id: [u8; 32],
        max_price_age_secs: u64,
        initial_price: u64,
    ) -> Result<()> {
        require!(max_price_age_secs > 0, StockSpendError::InvalidPriceAge);
        let price = if feed_id == MOCK_FEED_ID {
            require!(initial_price > 0, StockSpendError::InvalidPrice);
            initial_price
        } else {
            0
        };
        let m = &mut ctx.accounts.market;
        m.feed_id = feed_id;
        m.max_price_age_secs = max_price_age_secs;
        m.stock_mint = ctx.accounts.stock_mint.key();
        m.vault = ctx.accounts.vault.key();
        m.decimals = ctx.accounts.stock_mint.decimals;
        m.price = price;
        m.price_updated_at = Clock::get()?.unix_timestamp;
        m.total_collateral = 0;
        m.total_debt = 0;
        m.bump = ctx.bumps.market;
        Ok(())
    }

    pub fn update_price(ctx: Context<UpdatePrice>, price: u64) -> Result<()> {
        require!(price > 0, StockSpendError::InvalidPrice);
        let m = &mut ctx.accounts.market;
        require!(m.feed_id == MOCK_FEED_ID, StockSpendError::NotMockMarket);
        m.price = price;
        m.price_updated_at = Clock::get()?.unix_timestamp;
        Ok(())
    }

    pub fn fund_treasury(ctx: Context<FundTreasury>, amount: u64) -> Result<()> {
        require!(amount > 0, StockSpendError::ZeroAmount);
        transfer_checked(
            &ctx.accounts.token_program,
            &ctx.accounts.funder_usdc,
            &ctx.accounts.treasury,
            &ctx.accounts.usdc_mint,
            ctx.accounts.funder.to_account_info(),
            amount,
            None,
        )
    }

    pub fn mint_mock(ctx: Context<MintMock>, amount: u64) -> Result<()> {
        require!(amount > 0, StockSpendError::ZeroAmount);
        let cfg = &ctx.accounts.config;
        let mint = &ctx.accounts.mint;
        if ctx.accounts.signer.key() != cfg.admin {
            let whole = if mint.key() == cfg.usdc_mint { FAUCET_CAP_USDC } else { FAUCET_CAP_SHARES };
            let cap = whole
                .checked_mul(10u64.pow(mint.decimals as u32))
                .ok_or(StockSpendError::MathOverflow)?;
            require!(amount <= cap, StockSpendError::FaucetCapExceeded);
        }
        let seeds: &[&[u8]] = &[CONFIG_SEED, &[cfg.bump]];
        token_interface::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: mint.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: cfg.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )
    }

    /// Deposit stock tokens as collateral.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, StockSpendError::ZeroAmount);

        transfer_checked(
            &ctx.accounts.token_program,
            &ctx.accounts.owner_stock,
            &ctx.accounts.vault,
            &ctx.accounts.stock_mint,
            ctx.accounts.owner.to_account_info(),
            amount,
            None,
        )?;

        let pos = &mut ctx.accounts.position;
        pos.owner = ctx.accounts.owner.key();
        pos.market = ctx.accounts.market.key();
        pos.bump = ctx.bumps.position;
        pos.collateral = pos.collateral.checked_add(amount).ok_or(StockSpendError::MathOverflow)?;

        let m = &mut ctx.accounts.market;
        m.total_collateral = m.total_collateral.checked_add(amount).ok_or(StockSpendError::MathOverflow)?;

        emit!(Deposited { owner: pos.owner, market: pos.market, amount });
        Ok(())
    }

    /// Withdraw collateral, as long as the remaining position stays within LTV.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        require!(amount > 0, StockSpendError::ZeroAmount);
        let pos = &mut ctx.accounts.position;
        require!(pos.collateral >= amount, StockSpendError::InsufficientCollateral);

        pos.collateral -= amount;
        let price = ctx.accounts.market.current_price(ctx.accounts.price_update.as_deref())?;
        let max_debt = ctx.accounts.market.max_debt(pos.collateral, price, ctx.accounts.config.ltv_bps)?;
        require!(pos.debt <= max_debt, StockSpendError::ExceedsLtv);

        let m = &mut ctx.accounts.market;
        m.total_collateral = m.total_collateral.checked_sub(amount).ok_or(StockSpendError::MathOverflow)?;

        let mint_key = m.stock_mint;
        let seeds: &[&[u8]] = &[MARKET_SEED, mint_key.as_ref(), &[m.bump]];
        transfer_checked(
            &ctx.accounts.token_program,
            &ctx.accounts.vault,
            &ctx.accounts.owner_stock,
            &ctx.accounts.stock_mint,
            m.to_account_info(),
            amount,
            Some(&[seeds]),
        )?;

        emit!(Withdrawn { owner: pos.owner, market: pos.market, amount });
        Ok(())
    }

    /// Borrow USDC from the treasury against the position's collateral.
    pub fn borrow(ctx: Context<Borrow>, amount: u64) -> Result<()> {
        require!(amount > 0, StockSpendError::ZeroAmount);
        let pos = &mut ctx.accounts.position;

        let new_debt = pos.debt.checked_add(amount).ok_or(StockSpendError::MathOverflow)?;
        let price = ctx.accounts.market.current_price(ctx.accounts.price_update.as_deref())?;
        let max_debt = ctx.accounts.market.max_debt(pos.collateral, price, ctx.accounts.config.ltv_bps)?;
        require!(new_debt <= max_debt, StockSpendError::ExceedsLtv);
        require!(ctx.accounts.treasury.amount >= amount, StockSpendError::InsufficientLiquidity);

        pos.debt = new_debt;
        let m = &mut ctx.accounts.market;
        m.total_debt = m.total_debt.checked_add(amount).ok_or(StockSpendError::MathOverflow)?;

        let cfg = &ctx.accounts.config;
        let seeds: &[&[u8]] = &[CONFIG_SEED, &[cfg.bump]];
        transfer_checked(
            &ctx.accounts.token_program,
            &ctx.accounts.treasury,
            &ctx.accounts.owner_usdc,
            &ctx.accounts.usdc_mint,
            cfg.to_account_info(),
            amount,
            Some(&[seeds]),
        )?;

        emit!(Borrowed { owner: pos.owner, market: pos.market, amount, debt: pos.debt });
        Ok(())
    }

    /// Repay USDC debt. Amounts above the outstanding debt are capped.
    pub fn repay(ctx: Context<Repay>, amount: u64) -> Result<()> {
        require!(amount > 0, StockSpendError::ZeroAmount);
        let pos = &mut ctx.accounts.position;
        let amount = amount.min(pos.debt);
        require!(amount > 0, StockSpendError::NoDebt);

        transfer_checked(
            &ctx.accounts.token_program,
            &ctx.accounts.owner_usdc,
            &ctx.accounts.treasury,
            &ctx.accounts.usdc_mint,
            ctx.accounts.owner.to_account_info(),
            amount,
            None,
        )?;

        pos.debt -= amount;
        let m = &mut ctx.accounts.market;
        m.total_debt = m.total_debt.checked_sub(amount).ok_or(StockSpendError::MathOverflow)?;

        emit!(Repaid { owner: pos.owner, market: pos.market, amount, debt: pos.debt });
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub usdc_mint: Pubkey,
    pub treasury: Pubkey,
    pub ltv_bps: u16,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub stock_mint: Pubkey,
    pub vault: Pubkey,
    /// Pyth price feed id, or MOCK_FEED_ID for admin-priced markets.
    pub feed_id: [u8; 32],
    /// Reject prices (Pyth or mock) older than this.
    pub max_price_age_secs: u64,
    pub decimals: u8,
    /// Mock price only (USD * 10^6 per whole share).
    pub price: u64,
    pub price_updated_at: i64,
    pub total_collateral: u64,
    pub total_debt: u64,
    pub bump: u8,
}

impl Market {
    pub fn is_mock(&self) -> bool {
        self.feed_id == MOCK_FEED_ID
    }

    /// Current share price in USD * 10^6, from Pyth or the mock oracle.
    pub fn current_price(&self, price_update: Option<&PriceUpdateV2>) -> Result<u64> {
        let clock = Clock::get()?;
        if self.is_mock() {
            let age = clock.unix_timestamp.saturating_sub(self.price_updated_at);
            require!(age >= 0 && (age as u64) <= self.max_price_age_secs, StockSpendError::StalePrice);
            return Ok(self.price);
        }
        let update = price_update.ok_or(StockSpendError::MissingPriceUpdate)?;
        let p = update
            .get_price_no_older_than(&clock, self.max_price_age_secs, &self.feed_id)
            .map_err(|e| match e {
                GetPriceError::PriceTooOld => StockSpendError::StalePrice,
                GetPriceError::MismatchedFeedId => StockSpendError::WrongPriceFeed,
                _ => StockSpendError::UnverifiedPrice,
            })?;
        to_usd_micro(p.price, p.exponent)
    }

    /// Value of `amount` raw stock units in USDC base units at `price` (USD * 10^6).
    pub fn collateral_value(&self, amount: u64, price: u64) -> Result<u64> {
        let value = (amount as u128)
            .checked_mul(price as u128)
            .ok_or(StockSpendError::MathOverflow)?
            / 10u128.pow(self.decimals as u32);
        u64::try_from(value).map_err(|_| error!(StockSpendError::MathOverflow))
    }

    pub fn max_debt(&self, collateral: u64, price: u64, ltv_bps: u16) -> Result<u64> {
        let value = self.collateral_value(collateral, price)? as u128;
        let max = value * ltv_bps as u128 / BPS as u128;
        u64::try_from(max).map_err(|_| error!(StockSpendError::MathOverflow))
    }
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub collateral: u64,
    pub debt: u64,
    pub bump: u8,
}

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,
    pub usdc_mint: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = admin,
        associated_token::mint = usdc_mint,
        associated_token::authority = config,
        associated_token::token_program = token_program
    )]
    pub treasury: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateMarket<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
    pub stock_mint: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = admin,
        space = 8 + Market::INIT_SPACE,
        seeds = [MARKET_SEED, stock_mint.key().as_ref()],
        bump
    )]
    pub market: Account<'info, Market>,
    #[account(
        init,
        payer = admin,
        associated_token::mint = stock_mint,
        associated_token::authority = market,
        associated_token::token_program = token_program
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdatePrice<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [MARKET_SEED, market.stock_mint.as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
}

#[derive(Accounts)]
pub struct FundTreasury<'info> {
    pub funder: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = usdc_mint, has_one = treasury)]
    pub config: Account<'info, Config>,
    pub usdc_mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub treasury: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = funder,
        associated_token::token_program = token_program
    )]
    pub funder_usdc: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct MintMock<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, mint::authority = config)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        init_if_needed,
        payer = signer,
        associated_token::mint = mint,
        associated_token::authority = signer,
        associated_token::token_program = token_program
    )]
    pub destination: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    pub stock_mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        seeds = [MARKET_SEED, stock_mint.key().as_ref()],
        bump = market.bump,
        has_one = stock_mint,
        has_one = vault
    )]
    pub market: Account<'info, Market>,
    #[account(mut)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = stock_mint,
        associated_token::authority = owner,
        associated_token::token_program = token_program
    )]
    pub owner_stock: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + Position::INIT_SPACE,
        seeds = [POSITION_SEED, owner.key().as_ref(), market.key().as_ref()],
        bump
    )]
    pub position: Account<'info, Position>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    pub stock_mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        seeds = [MARKET_SEED, stock_mint.key().as_ref()],
        bump = market.bump,
        has_one = stock_mint,
        has_one = vault
    )]
    pub market: Account<'info, Market>,
    #[account(mut)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = stock_mint,
        associated_token::authority = owner,
        associated_token::token_program = token_program
    )]
    pub owner_stock: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [POSITION_SEED, owner.key().as_ref(), market.key().as_ref()],
        bump = position.bump,
        has_one = owner,
        has_one = market
    )]
    pub position: Account<'info, Position>,
    /// Pyth price update for the market's feed. Required unless the market is mock-priced.
    pub price_update: Option<Account<'info, PriceUpdateV2>>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Borrow<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = usdc_mint, has_one = treasury)]
    pub config: Account<'info, Config>,
    pub usdc_mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub treasury: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = owner,
        associated_token::mint = usdc_mint,
        associated_token::authority = owner,
        associated_token::token_program = token_program
    )]
    pub owner_usdc: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, seeds = [MARKET_SEED, market.stock_mint.as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(
        mut,
        seeds = [POSITION_SEED, owner.key().as_ref(), market.key().as_ref()],
        bump = position.bump,
        has_one = owner,
        has_one = market
    )]
    pub position: Account<'info, Position>,
    /// Pyth price update for the market's feed. Required unless the market is mock-priced.
    pub price_update: Option<Account<'info, PriceUpdateV2>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Repay<'info> {
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = usdc_mint, has_one = treasury)]
    pub config: Account<'info, Config>,
    pub usdc_mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub treasury: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = owner,
        associated_token::token_program = token_program
    )]
    pub owner_usdc: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, seeds = [MARKET_SEED, market.stock_mint.as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(
        mut,
        seeds = [POSITION_SEED, owner.key().as_ref(), market.key().as_ref()],
        bump = position.bump,
        has_one = owner,
        has_one = market
    )]
    pub position: Account<'info, Position>,
    pub token_program: Interface<'info, TokenInterface>,
}

// ---------------------------------------------------------------------------
// Events & errors
// ---------------------------------------------------------------------------

#[event]
pub struct Deposited {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub amount: u64,
}

#[event]
pub struct Withdrawn {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub amount: u64,
}

#[event]
pub struct Borrowed {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub amount: u64,
    pub debt: u64,
}

#[event]
pub struct Repaid {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub amount: u64,
    pub debt: u64,
}

#[error_code]
pub enum StockSpendError {
    #[msg("LTV must be between 1 and 9999 bps")]
    InvalidLtv,
    #[msg("Price must be greater than zero")]
    InvalidPrice,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Not enough collateral in position")]
    InsufficientCollateral,
    #[msg("Position would exceed the maximum loan-to-value")]
    ExceedsLtv,
    #[msg("Treasury does not have enough USDC")]
    InsufficientLiquidity,
    #[msg("Position has no outstanding debt")]
    NoDebt,
    #[msg("Max price age must be greater than zero")]
    InvalidPriceAge,
    #[msg("This market is priced by Pyth, not the mock oracle")]
    NotMockMarket,
    #[msg("A Pyth price update account is required for this market")]
    MissingPriceUpdate,
    #[msg("Price update is for a different feed")]
    WrongPriceFeed,
    #[msg("Price update is not fully verified")]
    UnverifiedPrice,
    #[msg("Faucet amount exceeds the per-call cap")]
    FaucetCapExceeded,
    #[msg("Oracle price is stale")]
    StalePrice,
    #[msg("Math overflow")]
    MathOverflow,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Convert a Pyth `price * 10^exponent` into USD * 10^PRICE_DECIMALS.
fn to_usd_micro(price: i64, exponent: i32) -> Result<u64> {
    require!(price > 0, StockSpendError::InvalidPrice);
    let p = price as u128;
    let target = -(PRICE_DECIMALS as i32);
    let scaled = if exponent <= target {
        p / 10u128.pow((target - exponent) as u32)
    } else {
        p.checked_mul(10u128.pow((exponent - target) as u32))
            .ok_or(StockSpendError::MathOverflow)?
    };
    require!(scaled > 0, StockSpendError::InvalidPrice);
    u64::try_from(scaled).map_err(|_| error!(StockSpendError::MathOverflow))
}

fn transfer_checked<'info>(
    token_program: &Interface<'info, TokenInterface>,
    from: &InterfaceAccount<'info, TokenAccount>,
    to: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    authority: AccountInfo<'info>,
    amount: u64,
    signer_seeds: Option<&[&[&[u8]]]>,
) -> Result<()> {
    let accounts = TransferChecked {
        from: from.to_account_info(),
        to: to.to_account_info(),
        mint: mint.to_account_info(),
        authority,
    };
    let ctx = match signer_seeds {
        Some(seeds) => CpiContext::new_with_signer(token_program.to_account_info(), accounts, seeds),
        None => CpiContext::new(token_program.to_account_info(), accounts),
    };
    token_interface::transfer_checked(ctx, amount, mint.decimals)
}
