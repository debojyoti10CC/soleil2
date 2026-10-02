//! Native Soleil classic-SPL-token vault. Deployment upgrade authority must separately be revoked.
#![allow(unexpected_cfgs)]
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint::ProgramResult,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    program_option::COption,
    program_pack::Pack,
    pubkey,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction, system_program,
    sysvar::Sysvar,
};
use spl_token::state::{Account as TokenAccount, AccountState, Mint};
#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);
pub const VAULT_LEN: usize = 122;
pub const CLAIM_LEN: usize = 122;
pub const VAULT_MAGIC: &[u8; 8] = b"SOLVAU01";
pub const CLAIM_MAGIC: &[u8; 8] = b"SOLCLM01";
pub const MAX_BATCH: usize = 16;
pub const ATA_PROGRAM: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum SoleilError {
    InvalidInput = 6000,
    Unauthorized,
    InvalidPda,
    InvalidAccount,
    InvalidAsset,
    Retired,
    AlreadyConsumed,
    InsufficientCoverage,
    UnknownClaim,
    AlreadyPaid,
    NotDue,
    IncorrectDelivery,
    OutstandingLiabilities,
    Arithmetic,
}
impl From<SoleilError> for ProgramError {
    fn from(v: SoleilError) -> Self {
        Self::Custom(v as u32)
    }
}
type Result<T> = std::result::Result<T, ProgramError>;
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Vault {
    pub employer: Pubkey,
    pub mint: Pubkey,
    pub id: [u8; 32],
    pub buffer: u64,
    pub committed: u64,
    pub retired: bool,
    pub bump: u8,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Claim {
    pub vault: Pubkey,
    pub id: [u8; 32],
    pub beneficiary: Pubkey,
    pub amount: u64,
    pub due: i64,
    pub paid: bool,
    pub bump: u8,
}
fn array<const N: usize>(data: &[u8], offset: usize) -> Result<[u8; N]> {
    data.get(offset..offset + N)
        .ok_or(SoleilError::InvalidInput.into())
        .and_then(|v| v.try_into().map_err(|_| SoleilError::InvalidInput.into()))
}
fn amount(data: &[u8], offset: usize) -> Result<u64> {
    Ok(u64::from_le_bytes(array(data, offset)?))
}
impl Vault {
    pub fn unpack(data: &[u8]) -> Result<Self> {
        if data.len() != VAULT_LEN || data.get(..8) != Some(VAULT_MAGIC.as_slice()) || data[120] > 1
        {
            return Err(SoleilError::InvalidAccount.into());
        }
        Ok(Self {
            employer: Pubkey::new_from_array(array(data, 8)?),
            mint: Pubkey::new_from_array(array(data, 40)?),
            id: array(data, 72)?,
            buffer: amount(data, 104)?,
            committed: amount(data, 112)?,
            retired: data[120] == 1,
            bump: data[121],
        })
    }
    pub fn pack(&self, data: &mut [u8]) -> ProgramResult {
        if data.len() != VAULT_LEN {
            return Err(SoleilError::InvalidAccount.into());
        }
        data[..8].copy_from_slice(VAULT_MAGIC);
        data[8..40].copy_from_slice(self.employer.as_ref());
        data[40..72].copy_from_slice(self.mint.as_ref());
        data[72..104].copy_from_slice(&self.id);
        data[104..112].copy_from_slice(&self.buffer.to_le_bytes());
        data[112..120].copy_from_slice(&self.committed.to_le_bytes());
        data[120] = u8::from(self.retired);
        data[121] = self.bump;
        Ok(())
    }
    pub fn reserve(&self) -> Result<u64> {
        self.committed
            .checked_add(if self.retired { 0 } else { self.buffer })
            .ok_or(SoleilError::Arithmetic.into())
    }
    pub fn with_commitment(&self, liquid: u64, value: u64) -> Result<u64> {
        if self.retired {
            return Err(SoleilError::Retired.into());
        }
        if value == 0 {
            return Err(SoleilError::InvalidInput.into());
        }
        let next = self
            .committed
            .checked_add(value)
            .ok_or(SoleilError::Arithmetic)?;
        if liquid
            < next
                .checked_add(self.buffer)
                .ok_or(SoleilError::Arithmetic)?
        {
            return Err(SoleilError::InsufficientCoverage.into());
        }
        Ok(next)
    }
    pub fn validate_withdrawal(&self, liquid: u64, value: u64) -> ProgramResult {
        if value == 0 {
            return Err(SoleilError::InvalidInput.into());
        }
        if liquid
            < self
                .reserve()?
                .checked_add(value)
                .ok_or(SoleilError::Arithmetic)?
        {
            return Err(SoleilError::InsufficientCoverage.into());
        }
        Ok(())
    }
    pub fn validate_pay(&self, claim: &Claim, liquid: u64, now: i64) -> ProgramResult {
        if claim.paid {
            return Err(SoleilError::AlreadyPaid.into());
        }
        if now < claim.due {
            return Err(SoleilError::NotDue.into());
        }
        if liquid < self.committed {
            return Err(SoleilError::InsufficientCoverage.into());
        }
        if claim.amount == 0 || claim.amount > self.committed {
            return Err(SoleilError::InvalidAccount.into());
        }
        Ok(())
    }
}
impl Claim {
    pub fn unpack(data: &[u8]) -> Result<Self> {
        if data.len() != CLAIM_LEN || data.get(..8) != Some(CLAIM_MAGIC.as_slice()) || data[120] > 1
        {
            return Err(SoleilError::UnknownClaim.into());
        }
        Ok(Self {
            vault: Pubkey::new_from_array(array(data, 8)?),
            id: array(data, 40)?,
            beneficiary: Pubkey::new_from_array(array(data, 72)?),
            amount: amount(data, 104)?,
            due: i64::from_le_bytes(array(data, 112)?),
            paid: data[120] == 1,
            bump: data[121],
        })
    }
    pub fn pack(&self, data: &mut [u8]) -> ProgramResult {
        if data.len() != CLAIM_LEN {
            return Err(SoleilError::InvalidAccount.into());
        }
        data[..8].copy_from_slice(CLAIM_MAGIC);
        data[8..40].copy_from_slice(self.vault.as_ref());
        data[40..72].copy_from_slice(&self.id);
        data[72..104].copy_from_slice(self.beneficiary.as_ref());
        data[104..112].copy_from_slice(&self.amount.to_le_bytes());
        data[112..120].copy_from_slice(&self.due.to_le_bytes());
        data[120] = u8::from(self.paid);
        data[121] = self.bump;
        Ok(())
    }
}
pub fn vault_pda(
    program: &Pubkey,
    employer: &Pubkey,
    mint: &Pubkey,
    id: &[u8; 32],
) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[b"soleil-v1", employer.as_ref(), mint.as_ref(), id],
        program,
    )
}
pub fn token_pda(program: &Pubkey, vault: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"soleil-token", vault.as_ref()], program)
}
pub fn claim_pda(program: &Pubkey, vault: &Pubkey, id: &[u8; 32]) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"soleil-claim", vault.as_ref(), id], program)
}
pub fn recipient_ata(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[owner.as_ref(), spl_token::id().as_ref(), mint.as_ref()],
        &ATA_PROGRAM,
    )
    .0
}
fn writable(a: &AccountInfo) -> ProgramResult {
    if !a.is_writable {
        return Err(SoleilError::InvalidAccount.into());
    }
    Ok(())
}
fn signer(a: &AccountInfo) -> ProgramResult {
    if !a.is_signer {
        return Err(SoleilError::Unauthorized.into());
    }
    Ok(())
}
fn token_program(a: &AccountInfo) -> ProgramResult {
    if a.key != &spl_token::id() || !a.executable {
        return Err(SoleilError::InvalidAsset.into());
    }
    Ok(())
}
fn system(a: &AccountInfo) -> ProgramResult {
    if a.key != &system_program::id() || !a.executable {
        return Err(SoleilError::InvalidAccount.into());
    }
    Ok(())
}
fn load_vault(program: &Pubkey, a: &AccountInfo) -> Result<Vault> {
    if a.owner != program {
        return Err(SoleilError::InvalidAccount.into());
    }
    let v = Vault::unpack(&a.try_borrow_data()?)?;
    let (expected, bump) = vault_pda(program, &v.employer, &v.mint, &v.id);
    if a.key != &expected || bump != v.bump {
        return Err(SoleilError::InvalidPda.into());
    }
    Ok(v)
}
fn employer(a: &AccountInfo, v: &Vault) -> ProgramResult {
    signer(a)?;
    if a.key != &v.employer {
        return Err(SoleilError::Unauthorized.into());
    }
    Ok(())
}
fn load_mint(a: &AccountInfo, expected: &Pubkey) -> Result<Mint> {
    if a.owner != &spl_token::id() || a.key != expected {
        return Err(SoleilError::InvalidAsset.into());
    }
    let m = Mint::unpack(&a.try_borrow_data()?)?;
    if m.decimals != 6 {
        return Err(SoleilError::InvalidAsset.into());
    }
    Ok(m)
}
fn load_token(a: &AccountInfo, mint: &Pubkey, owner: &Pubkey) -> Result<TokenAccount> {
    if a.owner != &spl_token::id() {
        return Err(SoleilError::InvalidAsset.into());
    }
    let t = TokenAccount::unpack(&a.try_borrow_data()?)?;
    if t.mint != *mint
        || t.owner != *owner
        || t.state != AccountState::Initialized
        || t.is_native != COption::None
    {
        return Err(SoleilError::InvalidAccount.into());
    }
    Ok(t)
}
fn vault_token(
    program: &Pubkey,
    a: &AccountInfo,
    va: &AccountInfo,
    v: &Vault,
) -> Result<TokenAccount> {
    if a.key != &token_pda(program, va.key).0 {
        return Err(SoleilError::InvalidPda.into());
    }
    let t = load_token(a, &v.mint, va.key)?;
    if t.delegate != COption::None || t.close_authority != COption::None || t.delegated_amount != 0
    {
        return Err(SoleilError::InvalidAccount.into());
    }
    Ok(t)
}
fn recipient(a: &AccountInfo, mint: &Pubkey, owner: &Pubkey) -> Result<TokenAccount> {
    if a.key != &recipient_ata(owner, mint) {
        return Err(SoleilError::InvalidPda.into());
    }
    load_token(a, mint, owner)
}
/// Prefunded system PDAs are allocated without accepting existing state or allowing reset.
fn create_pda<'a>(
    payer: &AccountInfo<'a>,
    a: &AccountInfo<'a>,
    sys: &AccountInfo<'a>,
    owner: &Pubkey,
    len: usize,
    seeds: &[&[u8]],
) -> ProgramResult {
    signer(payer)?;
    writable(payer)?;
    writable(a)?;
    system(sys)?;
    if a.owner != &system_program::id() || !a.data_is_empty() {
        return Err(SoleilError::AlreadyConsumed.into());
    }
    let missing = Rent::get()?
        .minimum_balance(len)
        .saturating_sub(a.lamports());
    if missing > 0 {
        invoke(
            &system_instruction::transfer(payer.key, a.key, missing),
            &[payer.clone(), a.clone(), sys.clone()],
        )?
    }
    invoke_signed(
        &system_instruction::allocate(a.key, len as u64),
        &[a.clone(), sys.clone()],
        &[seeds],
    )?;
    invoke_signed(
        &system_instruction::assign(a.key, owner),
        &[a.clone(), sys.clone()],
        &[seeds],
    )?;
    Ok(())
}
fn transfer_checked<'a>(
    source: &AccountInfo<'a>,
    mint: &AccountInfo<'a>,
    target: &AccountInfo<'a>,
    authority: &AccountInfo<'a>,
    tp: &AccountInfo<'a>,
    value: u64,
    seeds: &[&[u8]],
) -> ProgramResult {
    if source.key == target.key {
        return Err(SoleilError::InvalidAccount.into());
    }
    writable(source)?;
    writable(target)?;
    token_program(tp)?;
    let sb = TokenAccount::unpack(&source.try_borrow_data()?)?.amount;
    let tb = TokenAccount::unpack(&target.try_borrow_data()?)?.amount;
    let ix = spl_token::instruction::transfer_checked(
        &spl_token::id(),
        source.key,
        mint.key,
        target.key,
        authority.key,
        &[],
        value,
        6,
    )?;
    let ai = [
        source.clone(),
        mint.clone(),
        target.clone(),
        authority.clone(),
        tp.clone(),
    ];
    if seeds.is_empty() {
        invoke(&ix, &ai)?
    } else {
        invoke_signed(&ix, &ai, &[seeds])?
    }
    let sa = TokenAccount::unpack(&source.try_borrow_data()?)?.amount;
    let ta = TokenAccount::unpack(&target.try_borrow_data()?)?.amount;
    if sb.checked_sub(sa) != Some(value) || ta.checked_sub(tb) != Some(value) {
        return Err(SoleilError::IncorrectDelivery.into());
    }
    Ok(())
}
/// Strict length dispatch; no generic CPI, cancellation, setAuthority, approve or close exists.
pub fn process_instruction(
    program: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let (&tag, rest) = data.split_first().ok_or(SoleilError::InvalidInput)?;
    match tag {
        0 if rest.len() == 40 => initialize(program, accounts, array(rest, 0)?, amount(rest, 32)?),
        1 if rest.len() == 8 => deposit(program, accounts, amount(rest, 0)?),
        2 if rest.len() == 80 => commit(
            program,
            accounts,
            array(rest, 0)?,
            Pubkey::new_from_array(array(rest, 32)?),
            amount(rest, 64)?,
            i64::from_le_bytes(array(rest, 72)?),
        ),
        3 if rest.len() == 32 => pay(program, accounts, array(rest, 0)?),
        4 if rest.len() == 8 => withdraw(program, accounts, amount(rest, 0)?),
        5 if rest.is_empty() => retire(program, accounts),
        6 => pay_many(program, accounts, rest),
        _ => Err(SoleilError::InvalidInput.into()),
    }
}
fn initialize(
    program: &Pubkey,
    accounts: &[AccountInfo],
    id: [u8; 32],
    buffer: u64,
) -> ProgramResult {
    if accounts.len() != 6 || id == [0; 32] {
        return Err(SoleilError::InvalidInput.into());
    }
    let it = &mut accounts.iter();
    let payer = next_account_info(it)?;
    let va = next_account_info(it)?;
    let ta = next_account_info(it)?;
    let mint = next_account_info(it)?;
    let tp = next_account_info(it)?;
    let sys = next_account_info(it)?;
    signer(payer)?;
    token_program(tp)?;
    system(sys)?;
    load_mint(mint, mint.key)?;
    let (expected, bump) = vault_pda(program, payer.key, mint.key, &id);
    if va.key != &expected {
        return Err(SoleilError::InvalidPda.into());
    }
    let (expected_token, tb) = token_pda(program, va.key);
    if ta.key != &expected_token {
        return Err(SoleilError::InvalidPda.into());
    }
    let bb = [bump];
    create_pda(
        payer,
        va,
        sys,
        program,
        VAULT_LEN,
        &[
            b"soleil-v1",
            payer.key.as_ref(),
            mint.key.as_ref(),
            &id,
            &bb,
        ],
    )?;
    let tbb = [tb];
    create_pda(
        payer,
        ta,
        sys,
        &spl_token::id(),
        TokenAccount::LEN,
        &[b"soleil-token", va.key.as_ref(), &tbb],
    )?;
    invoke(
        &spl_token::instruction::initialize_account3(&spl_token::id(), ta.key, mint.key, va.key)?,
        &[ta.clone(), mint.clone(), tp.clone()],
    )?;
    Vault {
        employer: *payer.key,
        mint: *mint.key,
        id,
        buffer,
        committed: 0,
        retired: false,
        bump,
    }
    .pack(&mut va.try_borrow_mut_data()?)
}
fn deposit(program: &Pubkey, accounts: &[AccountInfo], value: u64) -> ProgramResult {
    if accounts.len() != 6 || value == 0 {
        return Err(SoleilError::InvalidInput.into());
    }
    let payer = &accounts[0];
    let va = &accounts[1];
    let ta = &accounts[2];
    let source = &accounts[3];
    let mint = &accounts[4];
    let tp = &accounts[5];
    signer(payer)?;
    token_program(tp)?;
    let v = load_vault(program, va)?;
    load_mint(mint, &v.mint)?;
    vault_token(program, ta, va, &v)?;
    load_token(source, &v.mint, payer.key)?;
    transfer_checked(source, mint, ta, payer, tp, value, &[])
}
fn commit(
    program: &Pubkey,
    accounts: &[AccountInfo],
    id: [u8; 32],
    worker: Pubkey,
    value: u64,
    due: i64,
) -> ProgramResult {
    if accounts.len() != 7 || id == [0; 32] || worker == Pubkey::default() || due <= 0 {
        return Err(SoleilError::InvalidInput.into());
    }
    let payer = &accounts[0];
    let va = &accounts[1];
    let ta = &accounts[2];
    let ca = &accounts[3];
    let mint = &accounts[4];
    let tp = &accounts[5];
    let sys = &accounts[6];
    writable(va)?;
    token_program(tp)?;
    system(sys)?;
    let mut v = load_vault(program, va)?;
    employer(payer, &v)?;
    if worker == *va.key {
        return Err(SoleilError::InvalidInput.into());
    }
    load_mint(mint, &v.mint)?;
    let liquid = vault_token(program, ta, va, &v)?.amount;
    let next = v.with_commitment(liquid, value)?;
    let (expected, bump) = claim_pda(program, va.key, &id);
    if ca.key != &expected {
        return Err(SoleilError::InvalidPda.into());
    }
    let bb = [bump];
    create_pda(
        payer,
        ca,
        sys,
        program,
        CLAIM_LEN,
        &[b"soleil-claim", va.key.as_ref(), &id, &bb],
    )?;
    Claim {
        vault: *va.key,
        id,
        beneficiary: worker,
        amount: value,
        due,
        paid: false,
        bump,
    }
    .pack(&mut ca.try_borrow_mut_data()?)?;
    v.committed = next;
    v.pack(&mut va.try_borrow_mut_data()?)
}
fn pay(program: &Pubkey, accounts: &[AccountInfo], id: [u8; 32]) -> ProgramResult {
    if accounts.len() != 6 {
        return Err(SoleilError::InvalidInput.into());
    }
    pay_one(
        program,
        &accounts[0],
        &accounts[1],
        &accounts[2],
        &accounts[3],
        &accounts[4],
        &accounts[5],
        id,
    )
}
fn pay_one<'a>(
    program: &Pubkey,
    va: &AccountInfo<'a>,
    ta: &AccountInfo<'a>,
    ca: &AccountInfo<'a>,
    target: &AccountInfo<'a>,
    mint: &AccountInfo<'a>,
    tp: &AccountInfo<'a>,
    id: [u8; 32],
) -> ProgramResult {
    writable(va)?;
    writable(ca)?;
    token_program(tp)?;
    let mut v = load_vault(program, va)?;
    load_mint(mint, &v.mint)?;
    let source = vault_token(program, ta, va, &v)?;
    if ca.owner != program {
        return Err(SoleilError::UnknownClaim.into());
    }
    let mut c = Claim::unpack(&ca.try_borrow_data()?)?;
    let (expected, bump) = claim_pda(program, va.key, &id);
    if ca.key != &expected || c.bump != bump || c.id != id || c.vault != *va.key {
        return Err(SoleilError::InvalidPda.into());
    }
    recipient(target, &v.mint, &c.beneficiary)?;
    v.validate_pay(&c, source.amount, Clock::get()?.unix_timestamp)?;
    let bb = [v.bump];
    transfer_checked(
        ta,
        mint,
        target,
        va,
        tp,
        c.amount,
        &[
            b"soleil-v1",
            v.employer.as_ref(),
            v.mint.as_ref(),
            &v.id,
            &bb,
        ],
    )?;
    v.committed = v
        .committed
        .checked_sub(c.amount)
        .ok_or(SoleilError::Arithmetic)?;
    c.paid = true;
    c.pack(&mut ca.try_borrow_mut_data()?)?;
    v.pack(&mut va.try_borrow_mut_data()?)
}
fn pay_many(program: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let count = *data.first().ok_or(SoleilError::InvalidInput)? as usize;
    if count == 0
        || count > MAX_BATCH
        || data.len() != 1 + count * 32
        || accounts.len() != 4 + count * 2
    {
        return Err(SoleilError::InvalidInput.into());
    }
    // Runtime transaction rollback makes the bounded loop atomic.
    for i in 0..count {
        pay_one(
            program,
            &accounts[0],
            &accounts[1],
            &accounts[4 + i * 2],
            &accounts[5 + i * 2],
            &accounts[2],
            &accounts[3],
            array(data, 1 + i * 32)?,
        )?
    }
    Ok(())
}
fn withdraw(program: &Pubkey, accounts: &[AccountInfo], value: u64) -> ProgramResult {
    if accounts.len() != 6 {
        return Err(SoleilError::InvalidInput.into());
    }
    let payer = &accounts[0];
    let va = &accounts[1];
    let ta = &accounts[2];
    let target = &accounts[3];
    let mint = &accounts[4];
    let tp = &accounts[5];
    token_program(tp)?;
    let v = load_vault(program, va)?;
    employer(payer, &v)?;
    load_mint(mint, &v.mint)?;
    let source = vault_token(program, ta, va, &v)?;
    recipient(target, &v.mint, &v.employer)?;
    v.validate_withdrawal(source.amount, value)?;
    let bb = [v.bump];
    transfer_checked(
        ta,
        mint,
        target,
        va,
        tp,
        value,
        &[
            b"soleil-v1",
            v.employer.as_ref(),
            v.mint.as_ref(),
            &v.id,
            &bb,
        ],
    )
}
fn retire(program: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    if accounts.len() != 2 {
        return Err(SoleilError::InvalidInput.into());
    }
    let mut v = load_vault(program, &accounts[1])?;
    employer(&accounts[0], &v)?;
    writable(&accounts[1])?;
    if v.retired {
        return Err(SoleilError::Retired.into());
    }
    if v.committed != 0 {
        return Err(SoleilError::OutstandingLiabilities.into());
    }
    v.retired = true;
    v.pack(&mut accounts[1].try_borrow_mut_data()?)
}
#[cfg(test)]
mod tests;
