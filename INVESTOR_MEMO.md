# Ghola

## The internet doesn't know who an agent is

AI agents can now make API calls, use tools, and execute multi-step workflows. The next step is obvious: they'll spend money. Make purchases, hire other agents, pay for services. Some already do.

But the internet has no way to verify that an agent is who it claims to be, that it's authorized to spend what it's spending, or that the entity on the other side of the transaction is real. There's no identity layer for machines. There's no financial constraint system designed for autonomous actors. There's no settlement infrastructure that assumes no human is present.

Every company deploying agents that transact is solving this internally with duct tape. Hardcoded spending limits. Bearer tokens with no scoping. Manual approval queues that defeat the purpose of automation. There's no protocol for it.

## Ghola is that protocol

Ghola is an identity and settlement protocol on Solana for autonomous agent commerce. Three primitives:

**Identity.** Every agent gets a verifiable on-chain identity. Cryptographic delegation chains prove who authorized the agent, what it's allowed to do, and when that authorization expires. Reputation scores build over time based on completed transactions. Both sides of every transaction know who they're dealing with.

**Financial constraints.** Agents operate within programmable budgets set by their principals. Spending limits per day, per transaction, per vendor. Allowlisted recipients. Time-bound authorization. Escrow before execution. If the agent hits a boundary, the transaction fails cleanly. No overdraft, no surprises.

**Settlement.** USDC escrow locks funds when work begins. Payment releases when work completes. Refunds automatically on failure. If a counterparty goes silent, auto-release protects the other side. No manual accounts payable. No reconciliation. Settlement is a protocol event, not a business process.

## How it works

An agent needs a service. It discovers a provider through Ghola's registry, verifies their identity and reputation on-chain, and pays in USDC. The provider is another agent, or a business exposing its API as a headless merchant. No human is involved. The agent has a budget, cryptographic proof of authorization, and constraints on what it can spend. Payment settles on completion. Both sides have a verifiable record of the transaction and the full chain of delegation that authorized it.

Humans can use the same system. A company posts a task with a USDC bounty. Someone claims it, completes the work, and gets paid. The same identity, escrow, and reputation infrastructure applies. But the core design assumes agents as first-class participants, not humans clicking buttons.

## What's built

Ghola is working software, not a whitepaper.

Rust backend, Next.js frontend, Solana on-chain program, live at ghola.xyz. The protocol includes an on-chain identity registry with reputation scoring, cryptographic delegation chains, agent wallets with HD derivation and spending policies, a service discovery protocol with SDKs in TypeScript and Python, a task marketplace with USDC escrow and settlement, and a pay-per-request protocol for anonymous agent access. 93 tests passing across the core libraries. 20 MCP tools for agent framework integration.

The first vertical application built on the protocol is Axioterm, an AI-native trading terminal where agents execute trades within programmable financial constraints, settling through Ghola's identity and payment layer. The protocol and its first app ship together.

## Why now

In 1999 most people didn't believe consumers would put their credit card into a website. By 2005 it was obvious they would. The infrastructure built during that window became the foundation of a trillion dollar industry. The teams that built it early owned it permanently.

We're at the same moment with agents. Most people don't believe an AI agent will autonomously spend money, hire another agent, or complete a paid task without a human approving every step. But the trajectory is clear. Spending money is just the next tool call. When that becomes normal, and it will become normal faster than people expect, every agent will need an identity, a budget, and a settlement layer. That infrastructure doesn't exist yet. We're building it now.

## Ask

We're raising a seed. The product is built. The next step is getting it into production with teams that are already deploying agents that spend money. These teams exist today. They're solving this problem internally with duct tape. The capital goes to finding them, embedding with them, and hiring one engineer so we can ship what they need fast enough to keep them.
