// @ts-nocheck
import assert from 'node:assert/strict';
import test from 'node:test';
import { GholaTreasuryClient } from '../treasury-execution';

test('GholaTreasuryClient runs an executable treasury intent', async () => {
  const calls: Array<[string, RequestInit | undefined]> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push([url.toString(), init]);
    return new Response(
      JSON.stringify({
        version: 1,
        ok: true,
        action: 'executed',
        simulation: { version: 1, ok: true },
        receipt: {
          version: 1,
          receipt_id: 'tex_1',
          intent_id: 'intent_1',
          owner_did: 'did:key:z6Mk',
          agent_id: 'agent_1',
          policy_hash: 'policy',
          proposal_hash: 'proposal',
          approval_hash: 'approval',
          approval_expires_at: '2999-01-01T00:00:00.000Z',
          amount_micro_usd: 50_000_000,
          rails: ['bank_cash'],
          provider_id: 'mock_treasury_partner',
          partner_refs: ['mock-submit:bank_cash:intent_1'],
          reconciliation_state: 'submitted',
          executed_at: '2026-05-25T00:00:00.000Z',
          public_fallback_used: false,
          signature: 'abc',
        },
        reconciliation_state: 'submitted',
        partner_refs: ['mock-submit:bank_cash:intent_1'],
      }),
      { status: 201, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;

  try {
    const client = new GholaTreasuryClient({
      baseUrl: 'https://ghola.test/',
      apiKey: 'sk_agent',
    });
    const result = await client.runTreasuryIntent({
      version: 1,
      policy: treasuryPolicy(),
      intent: treasuryIntent(),
    });

    assert.equal(result.ok, true);
    assert.equal(result.action, 'executed');
    assert.equal(result.receipt.agent_id, 'agent_1');
    assert.equal(calls[0][0], 'https://ghola.test/v1/treasury-intents/run');
    assert.equal(
      new Headers(calls[0][1]?.headers).get('authorization'),
      'Bearer sk_agent',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GholaTreasuryClient returns approval_required responses for agent workflow routing', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        version: 1,
        ok: false,
        action: 'approval_required',
        approval: {
          version: 1,
          approval_hash: 'abc',
          expires_at: '2999-01-01T00:00:00.000Z',
          scope: 'treasury_proposal',
        },
        simulation: { version: 1, ok: true },
      }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;

  try {
    const client = new GholaTreasuryClient({ baseUrl: 'https://ghola.test' });
    const result = await client.runTreasuryIntent({
      version: 1,
      policy: treasuryPolicy(),
      intent: treasuryIntent(),
    });

    assert.equal(result.ok, false);
    assert.equal(result.action, 'approval_required');
    assert.equal(result.approval.approval_hash, 'abc');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GholaTreasuryClient reconciles and cancels executable treasury intents', async () => {
  const calls: Array<[string, RequestInit | undefined]> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push([url.toString(), init]);
    const isCancel = url.toString().endsWith('/cancel');
    return new Response(
      JSON.stringify({
        version: 1,
        ok: true,
        intent_id: 'intent_1',
        reconciliation_state: isCancel ? 'cancelled' : 'submitted',
        reconciliations: [
          {
            version: 1,
            rail: 'bank_cash',
            partner_ref: 'mock-submit:bank_cash:intent_1',
            reconciliation_state: isCancel ? 'cancelled' : 'submitted',
          },
        ],
        partner_refs: ['mock-submit:bank_cash:intent_1'],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;

  try {
    const client = new GholaTreasuryClient({
      baseUrl: 'https://ghola.test/',
      apiKey: 'sk_agent',
    });
    const reconciled = await client.reconcileTreasuryIntent('intent_1');
    const cancelled = await client.cancelTreasuryIntent('intent_1');

    assert.equal(reconciled.reconciliation_state, 'submitted');
    assert.equal(cancelled.reconciliation_state, 'cancelled');
    assert.equal(calls[0][0], 'https://ghola.test/v1/treasury-intents/reconcile');
    assert.equal(calls[1][0], 'https://ghola.test/v1/treasury-intents/cancel');
    assert.deepEqual(JSON.parse(String(calls[0][1]?.body)), {
      version: 1,
      intent_id: 'intent_1',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GholaTreasuryClient rejects plaintext treasury payloads before fetch', async () => {
  let fetched = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetched = true;
    return new Response('{}', { status: 200 });
  }) as typeof fetch;

  try {
    const client = new GholaTreasuryClient({ baseUrl: 'https://ghola.test' });
    await assert.rejects(
      client.runTreasuryIntent({
        version: 1,
        policy: treasuryPolicy(),
        intent: treasuryIntent(),
        balances: { checking: 100 },
      } as never),
      /must not contain plaintext/,
    );
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function treasuryPolicy() {
  return {
    version: 1,
    policy_id: 'policy_1',
    owner_did: 'did:key:z6Mk',
    allowed_assets: ['USD', 'USDC', 'T_BILL'],
    allowed_payment_rails: ['stablecoin_shielded'],
    allowed_rails: ['bank_cash', 'treasury_bills', 'stablecoin_shielded'],
    allowed_partners: ['mock_treasury_partner'],
    max_action_micro_usd: 100_000_000,
    daily_action_micro_usd: 200_000_000,
    approval_required_above_micro_usd: 100_000_000,
    public_fallback_allowed: false,
  };
}

function treasuryIntent() {
  return {
    version: 1,
    intent_id: 'intent_1',
    owner_did: 'did:key:z6Mk',
    objective: 'maintain_runway',
    horizon_days: 90,
    amount_micro_usd: 50_000_000,
    constraints: {
      min_operating_cash_micro_usd: 20_000_000,
      min_instant_liquidity_micro_usd: 30_000_000,
      min_runway_months: 6,
      max_single_bank_exposure_bps: 5000,
      max_stablecoin_issuer_exposure_bps: 2500,
      max_duration_days: 120,
      approved_rails: ['bank_cash', 'treasury_bills', 'stablecoin_shielded'],
      approval_required_above_micro_usd: 100_000_000,
      public_fallback_allowed: false,
    },
    encrypted_context_bundle: {
      alg: 'sealed-provider-v1',
      ciphertext: 'sealed',
      recipient: 'provider',
      aad: 'treasury-intent-v1',
    },
  };
}
