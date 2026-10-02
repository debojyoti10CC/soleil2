#!/bin/sh
# Run in Linux / WSL. This foreground process is an isolated LOCAL validator only.
set -eu
umask 077
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
soleil_program_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
soleil_program_id=${SOLEIL_SOLANA_PROOF_PROGRAM:-7hSDwob28P159bXHhAQrampnvqX8DjaXjSQMKe3bktc3}
soleil_ledger=$(mktemp -d /var/tmp/soleil-local-validator.XXXXXX)
if [ ! -f "$soleil_program_dir/deploy/soleil_vault.so" ]; then
  printf 'Compile the SBF program first; see docs/CHAIN-CONTRACTS.md.\n' >&2
  exit 1
fi
printf 'Local-only RPC: http://127.0.0.1:19099\nFresh private ledger: %s\nProgram: %s\n' "$soleil_ledger" "$soleil_program_id"
# Explicit synthetic public mint avoids reading any default user wallet.
# No --reset: a fresh owned ledger is always used, and no existing ledger is modified.
exec solana-test-validator --config "$soleil_ledger/config.yml" --mint 6No9y9AwTpnvpcTYisNBbYwxix7C9B5ayJi8UWfM9tP3   --ledger "$soleil_ledger" --rpc-port 19099 --faucet-port 19900 --gossip-port 19102   --dynamic-port-range 19200-19250 --bpf-program "$soleil_program_id" "$soleil_program_dir/deploy/soleil_vault.so" --quiet
