#!/bin/sh
set -eu
umask 077
testnet_dir=$(mktemp -d /var/tmp/soleil-devnet.XXXXXX)
for name in deployer program buffer; do
  solana-keygen new --no-bip39-passphrase --silent --outfile "$testnet_dir/$name.json" --config "$testnet_dir/config.yml" >"$testnet_dir/$name-generation.log" 2>&1
  chmod 600 "$testnet_dir/$name.json"
done
deployer=$(solana-keygen pubkey "$testnet_dir/deployer.json")
program=$(solana-keygen pubkey "$testnet_dir/program.json")
printf 'TEST_DIRECTORY=%s\nDEPLOYER=%s\nPLANNED_PROGRAM=%s\n' "$testnet_dir" "$deployer" "$program"
if solana --url https://api.devnet.solana.com --keypair "$testnet_dir/deployer.json" --config "$testnet_dir/config.yml" airdrop 2 "$deployer" >"$testnet_dir/faucet.log" 2>&1; then
  printf 'FAUCET=SUCCESS\n'
else
  printf 'FAUCET=FAILED\n'
  grep '^Error:' "$testnet_dir/faucet.log" || true
  exit 2
fi
printf 'DEPLOYING=%s\n' "$program"
if solana --url https://api.devnet.solana.com --keypair "$testnet_dir/deployer.json" --config "$testnet_dir/config.yml" program deploy "$1" --program-id "$testnet_dir/program.json" --buffer "$testnet_dir/buffer.json" --upgrade-authority "$testnet_dir/deployer.json" --final --use-rpc --max-len 111512 --max-sign-attempts 2 >"$testnet_dir/deploy.log" 2>&1; then
  printf 'DEPLOYED_PROGRAM=%s\n' "$program"
  grep '^Signature:' "$testnet_dir/deploy.log" || true
  solana --url https://api.devnet.solana.com --keypair "$testnet_dir/deployer.json" --config "$testnet_dir/config.yml" program show "$program"
else
  printf 'DEPLOYMENT=FAILED\n'
  grep '^Error:' "$testnet_dir/deploy.log" || true
  exit 3
fi
