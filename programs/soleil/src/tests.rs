use super::*;
use solana_program::program_stubs::{set_syscall_stubs, SyscallStubs};
use std::sync::Mutex;
static STUB_LOCK: Mutex<()> = Mutex::new(());
fn fixture() -> Vault {
    Vault {
        employer: Pubkey::new_unique(),
        mint: Pubkey::new_unique(),
        id: [7; 32],
        buffer: 50,
        committed: 400,
        retired: false,
        bump: 254,
    }
}
fn info(
    key: Pubkey,
    owner: Pubkey,
    signer: bool,
    writable: bool,
    data: Vec<u8>,
    executable: bool,
) -> AccountInfo<'static> {
    AccountInfo::new(
        Box::leak(Box::new(key)),
        signer,
        writable,
        Box::leak(Box::new(1_000_000_000u64)),
        Box::leak(data.into_boxed_slice()),
        Box::leak(Box::new(owner)),
        executable,
        0,
    )
}
fn token_data(mint: Pubkey, owner: Pubkey, value: u64, frozen: bool) -> Vec<u8> {
    let mut data = vec![0; TokenAccount::LEN];
    TokenAccount::pack(
        TokenAccount {
            mint,
            owner,
            amount: value,
            delegate: COption::None,
            state: if frozen {
                AccountState::Frozen
            } else {
                AccountState::Initialized
            },
            is_native: COption::None,
            delegated_amount: 0,
            close_authority: COption::None,
        },
        &mut data,
    )
    .unwrap();
    data
}
fn mint_data() -> Vec<u8> {
    let mut data = vec![0; Mint::LEN];
    Mint::pack(
        Mint {
            mint_authority: COption::None,
            supply: 1000,
            decimals: 6,
            is_initialized: true,
            freeze_authority: COption::None,
        },
        &mut data,
    )
    .unwrap();
    data
}
#[test]
fn reserve_and_commitment_math_protect_principal_and_reject_overflow() {
    let v = fixture();
    assert_eq!(v.with_commitment(550, 100), Ok(500));
    assert!(v.with_commitment(549, 100).is_err());
    assert!(v.with_commitment(u64::MAX, u64::MAX).is_err());
    assert!(v.with_commitment(550, 0).is_err());
    assert!(v.validate_withdrawal(550, 100).is_ok());
    assert!(v.validate_withdrawal(550, 101).is_err());
    assert!(v.validate_withdrawal(550, u64::MAX).is_err());
}
#[test]
fn maturity_principal_and_replay_gates_are_distinct_from_buffer() {
    let v = fixture();
    let mut c = Claim {
        vault: Pubkey::new_unique(),
        id: [3; 32],
        beneficiary: Pubkey::new_unique(),
        amount: 100,
        due: 200,
        paid: false,
        bump: 200,
    };
    assert!(v.validate_pay(&c, 450, 199).is_err());
    assert!(v.validate_pay(&c, 399, 200).is_err());
    assert!(v.validate_pay(&c, 400, 200).is_ok());
    c.paid = true;
    assert!(v.validate_pay(&c, 450, 200).is_err());
}
#[test]
fn strict_layout_and_tombstones_survive_retirement() {
    let mut v = fixture();
    let mut data = vec![0; VAULT_LEN];
    v.pack(&mut data).unwrap();
    assert_eq!(Vault::unpack(&data).unwrap(), v);
    data[120] = 2;
    assert!(Vault::unpack(&data).is_err());
    v.retired = true;
    v.committed = 0;
    assert_eq!(v.reserve(), Ok(0));
    assert!(v.with_commitment(1000, 1).is_err());
    assert!(v.validate_withdrawal(1000, 1000).is_ok());
    let c = Claim {
        vault: Pubkey::new_unique(),
        id: [8; 32],
        beneficiary: Pubkey::new_unique(),
        amount: 100,
        due: 200,
        paid: true,
        bump: 255,
    };
    let mut data = vec![0; CLAIM_LEN];
    c.pack(&mut data).unwrap();
    assert_eq!(Claim::unpack(&data).unwrap(), c);
    assert!(Claim::unpack(&data[..CLAIM_LEN - 1]).is_err());
}
#[test]
fn vault_is_bound_to_employer_asset_identity_and_canonical_bump() {
    let program = Pubkey::new_unique();
    let mut v = fixture();
    let (key, bump) = vault_pda(&program, &v.employer, &v.mint, &v.id);
    v.bump = bump;
    let mut data = vec![0; VAULT_LEN];
    v.pack(&mut data).unwrap();
    assert_eq!(
        load_vault(
            &program,
            &info(key, program, false, true, data.clone(), false)
        )
        .unwrap(),
        v
    );
    assert!(load_vault(
        &program,
        &info(key, system_program::id(), false, true, data.clone(), false)
    )
    .is_err());
    assert!(load_vault(
        &program,
        &info(Pubkey::new_unique(), program, false, true, data, false)
    )
    .is_err());
    assert_ne!(
        key,
        vault_pda(&program, &v.employer, &Pubkey::new_unique(), &v.id).0
    );
    assert!(employer(
        &info(
            v.employer,
            system_program::id(),
            false,
            false,
            vec![],
            false
        ),
        &v
    )
    .is_err());
}
#[test]
fn token2022_wrong_mint_frozen_and_noncanonical_recipient_are_rejected() {
    let v = fixture();
    let owner = Pubkey::new_unique();
    let ata = recipient_ata(&owner, &v.mint);
    assert!(recipient(
        &info(
            ata,
            spl_token::id(),
            false,
            true,
            token_data(v.mint, owner, 0, false),
            false
        ),
        &v.mint,
        &owner
    )
    .is_ok());
    assert!(recipient(
        &info(
            ata,
            Pubkey::new_unique(),
            false,
            true,
            token_data(v.mint, owner, 0, false),
            false
        ),
        &v.mint,
        &owner
    )
    .is_err());
    assert!(recipient(
        &info(
            ata,
            spl_token::id(),
            false,
            true,
            token_data(Pubkey::new_unique(), owner, 0, false),
            false
        ),
        &v.mint,
        &owner
    )
    .is_err());
    assert!(recipient(
        &info(
            ata,
            spl_token::id(),
            false,
            true,
            token_data(v.mint, owner, 0, true),
            false
        ),
        &v.mint,
        &owner
    )
    .is_err());
    assert!(recipient(
        &info(
            Pubkey::new_unique(),
            spl_token::id(),
            false,
            true,
            token_data(v.mint, owner, 0, false),
            false
        ),
        &v.mint,
        &owner
    )
    .is_err());
}
#[test]
fn unrecognized_operations_and_unbounded_batches_do_not_expose_generic_execution() {
    let p = Pubkey::new_unique();
    for data in [&[][..], &[99][..], &[6, 0][..], &[6, 17][..]] {
        assert!(process_instruction(&p, &[], data).is_err())
    }
}

/// Host syscall adapter invokes the ACTUAL classic SPL-token processor and checks PDA seeds.
/// This is not an SBF VM, validator, RPC test or audit.
struct NativeCpi {
    program: Pubkey,
    now: i64,
}
impl SyscallStubs for NativeCpi {
    fn sol_get_clock_sysvar(&self, ptr: *mut u8) -> u64 {
        unsafe {
            std::ptr::write(
                ptr as *mut Clock,
                Clock {
                    unix_timestamp: self.now,
                    ..Clock::default()
                },
            );
        }
        0
    }
    fn sol_invoke_signed(
        &self,
        ix: &solana_program::instruction::Instruction,
        accounts: &[AccountInfo],
        seed_sets: &[&[&[u8]]],
    ) -> ProgramResult {
        if ix.program_id != spl_token::id() {
            return Err(ProgramError::IncorrectProgramId);
        }
        let signers: Vec<Pubkey> = seed_sets
            .iter()
            .map(|seeds| {
                Pubkey::create_program_address(seeds, &self.program)
                    .map_err(|_| ProgramError::InvalidSeeds)
            })
            .collect::<Result<Vec<_>>>()?;
        let mut ordered = Vec::new();
        for meta in &ix.accounts {
            let mut a = accounts
                .iter()
                .find(|a| a.key == &meta.pubkey)
                .ok_or(ProgramError::NotEnoughAccountKeys)?
                .clone();
            if signers.contains(a.key) {
                a.is_signer = true
            }
            ordered.push(a)
        }
        spl_token::processor::Processor::process(&ix.program_id, &ordered, &ix.data)
    }
}
fn payment_fixture(program: Pubkey) -> (Vec<AccountInfo<'static>>, [u8; 32], Pubkey, Pubkey) {
    let mut v = fixture();
    let (va, bump) = vault_pda(&program, &v.employer, &v.mint, &v.id);
    v.bump = bump;
    let id = [4; 32];
    let worker = Pubkey::new_unique();
    let (ca, cb) = claim_pda(&program, &va, &id);
    let c = Claim {
        vault: va,
        id,
        beneficiary: worker,
        amount: 100,
        due: 200,
        paid: false,
        bump: cb,
    };
    let mut vd = vec![0; VAULT_LEN];
    v.pack(&mut vd).unwrap();
    let mut cd = vec![0; CLAIM_LEN];
    c.pack(&mut cd).unwrap();
    let accounts = vec![
        info(va, program, false, true, vd, false),
        info(
            token_pda(&program, &va).0,
            spl_token::id(),
            false,
            true,
            token_data(v.mint, va, 450, false),
            false,
        ),
        info(ca, program, false, true, cd, false),
        info(
            recipient_ata(&worker, &v.mint),
            spl_token::id(),
            false,
            true,
            token_data(v.mint, worker, 0, false),
            false,
        ),
        info(v.mint, spl_token::id(), false, false, mint_data(), false),
        info(
            spl_token::id(),
            system_program::id(),
            false,
            false,
            vec![],
            true,
        ),
    ];
    (accounts, id, v.employer, v.mint)
}
#[test]
fn actual_classic_token_cpi_pays_fixed_worker_without_signer_then_blocks_replay() {
    let _lock = STUB_LOCK.lock().unwrap();
    let p = Pubkey::new_unique();
    let previous = set_syscall_stubs(Box::new(NativeCpi {
        program: p,
        now: 200,
    }));
    let (accounts, id, _, _) = payment_fixture(p);
    let mut data = vec![3];
    data.extend_from_slice(&id);
    process_instruction(&p, &accounts, &data).unwrap();
    assert_eq!(
        TokenAccount::unpack(&accounts[1].try_borrow_data().unwrap())
            .unwrap()
            .amount,
        350
    );
    assert_eq!(
        TokenAccount::unpack(&accounts[3].try_borrow_data().unwrap())
            .unwrap()
            .amount,
        100
    );
    assert_eq!(
        Vault::unpack(&accounts[0].try_borrow_data().unwrap())
            .unwrap()
            .committed,
        300
    );
    assert!(
        Claim::unpack(&accounts[2].try_borrow_data().unwrap())
            .unwrap()
            .paid
    );
    assert!(process_instruction(&p, &accounts, &data).is_err());
    set_syscall_stubs(previous);
}
#[test]
fn account_swap_frozen_worker_and_principal_shortfall_preserve_claim_and_funds() {
    let _lock = STUB_LOCK.lock().unwrap();
    let p = Pubkey::new_unique();
    let previous = set_syscall_stubs(Box::new(NativeCpi {
        program: p,
        now: 200,
    }));
    for attack in 0..3 {
        let (mut accounts, id, _, mint) = payment_fixture(p);
        if attack == 0 {
            let target_data = accounts[3].try_borrow_data().unwrap().to_vec();
            accounts[3] = info(
                Pubkey::new_unique(),
                spl_token::id(),
                false,
                true,
                target_data,
                false,
            );
        } else if attack == 1 {
            let mut target = TokenAccount::unpack(&accounts[3].try_borrow_data().unwrap()).unwrap();
            target.state = AccountState::Frozen;
            TokenAccount::pack(target, &mut accounts[3].try_borrow_mut_data().unwrap()).unwrap();
        } else {
            let owner = *accounts[0].key;
            accounts[1]
                .try_borrow_mut_data()
                .unwrap()
                .copy_from_slice(&token_data(mint, owner, 399, false));
        }
        let before = TokenAccount::unpack(&accounts[1].try_borrow_data().unwrap())
            .unwrap()
            .amount;
        let mut data = vec![3];
        data.extend_from_slice(&id);
        assert!(process_instruction(&p, &accounts, &data).is_err());
        assert_eq!(
            TokenAccount::unpack(&accounts[1].try_borrow_data().unwrap())
                .unwrap()
                .amount,
            before
        );
        assert_eq!(
            Vault::unpack(&accounts[0].try_borrow_data().unwrap())
                .unwrap()
                .committed,
            400
        );
        assert!(
            !Claim::unpack(&accounts[2].try_borrow_data().unwrap())
                .unwrap()
                .paid
        );
    }
    set_syscall_stubs(previous);
}
