#!/usr/bin/env python3
"""Approve a Hyperliquid API/agent wallet without a browser wallet.

The pool master key is a purpose-generated key, not a personal wallet, so
signing the ApproveAgent action programmatically is the intended flow.

Usage:
  pip install hyperliquid-python-sdk eth-account
  HL_MASTER_PRIVATE_KEY=0x... python3 scripts/hyperliquid-approve-agent.py \
      --network testnet --agent-name ghola-pooled

Generates a fresh agent keypair, signs/submits ApproveAgent with the
master key, and prints the managed-accounts JSON entry for sealed install.
Nothing is written to disk.
"""

import argparse
import json
import os
import secrets
import sys

from eth_account import Account
from hyperliquid.exchange import Exchange
from hyperliquid.utils import constants


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--network", choices=["testnet", "mainnet"], default="testnet")
    parser.add_argument("--agent-name", default="ghola-pooled")
    args = parser.parse_args()

    master_key = os.environ.get("HL_MASTER_PRIVATE_KEY", "").strip()
    if not master_key.startswith("0x") or len(master_key) != 66:
        print("HL_MASTER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key", file=sys.stderr)
        return 1

    base_url = constants.TESTNET_API_URL if args.network == "testnet" else constants.MAINNET_API_URL
    master = Account.from_key(master_key)

    agent_key = "0x" + secrets.token_hex(32)
    agent = Account.from_key(agent_key)

    exchange = Exchange(master, base_url)
    result = (
        exchange.approve_agent_key(agent.address, args.agent_name)
        if hasattr(exchange, "approve_agent_key")
        else exchange.approve_agent(args.agent_name)
    )

    # Older SDK versions generate the agent key internally and return it;
    # newer ones accept an externally supplied address. Handle both shapes.
    if isinstance(result, tuple):
        response, returned_key = result
        if returned_key:
            agent_key = returned_key
            agent = Account.from_key(agent_key)
    else:
        response = result

    status = response.get("status") if isinstance(response, dict) else None
    if status != "ok":
        print(f"approve_agent failed: {json.dumps(response)[:500]}", file=sys.stderr)
        return 1

    print(f"network: {args.network}", file=sys.stderr)
    print(f"master account address: {master.address}", file=sys.stderr)
    print(f"agent wallet address:   {agent.address}", file=sys.stderr)
    print("managed-accounts entry is on stdout for sealed install.", file=sys.stderr)
    print(json.dumps({
        "accounts": [{
            "network": args.network,
            "account_address": master.address.lower(),
            "api_wallet_private_key": agent_key.lower(),
            "agent_name": args.agent_name,
        }],
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
