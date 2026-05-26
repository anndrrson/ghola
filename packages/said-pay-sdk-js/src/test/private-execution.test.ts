// @ts-nocheck
import assert from 'node:assert/strict';
import test from 'node:test';
import { GholaPrivateExecutionClient } from '../private-execution';

test('GholaPrivateExecutionClient fetches status', async () => {
  const calls: Array<[string, RequestInit | undefined]> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push([url.toString(), init]);
    return new Response(
      JSON.stringify({
        version: 1,
        ready: true,
        supported_rails: ['railgun_private_swap'],
        fee_bps: 10,
        min_fee_micro_usdc: 50000,
        fee_recipient_configured: true,
        shielded_rail_ready: true,
        sealed_provider_ready: true,
        blocking_reasons: [],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;

  try {
    const client = new GholaPrivateExecutionClient({
      baseUrl: 'https://ghola.test/',
      apiKey: 'sk_agent',
    });
    const status = await client.getPrivateExecutionStatus();

    assert.equal(status.ready, true);
    assert.equal(calls[0][0], 'https://ghola.test/v1/private-intents/status');
    assert.equal(
      new Headers(calls[0][1]?.headers).get('authorization'),
      'Bearer sk_agent',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GholaPrivateExecutionClient rejects plaintext execution payloads before fetch', async () => {
  let fetched = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetched = true;
    return new Response('{}', { status: 200 });
  }) as typeof fetch;

  try {
    const client = new GholaPrivateExecutionClient({
      baseUrl: 'https://ghola.test',
      apiKey: 'sk_agent',
    });
    await assert.rejects(
      client.executePrivateIntent({
        version: 1,
        intent_id: 'intent_1',
        owner_did: 'did:key:z6Mk',
        policy_hash: 'policy',
        proposal_hash: 'proposal',
        amount_micro_usdc: 25_000_000,
        rail: 'railgun_private_swap',
        encrypted_intent_bundle: {
          alg: 'sealed-provider-v1',
          ciphertext: 'sealed',
          recipient: 'provider',
          aad: 'aad',
        },
        portfolio: { sol: 10 },
      } as never),
      /must not contain plaintext/,
    );
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GholaPrivateExecutionClient returns execution receipt', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        version: 1,
        ok: true,
        receipt: {
          version: 1,
          receipt_id: 'pex_1',
          intent_id: 'intent_1',
          agent_id: 'agent_1',
          policy_hash: 'policy',
          proposal_hash: 'proposal',
          rail: 'railgun_private_swap',
          amount_micro_usdc: 25_000_000,
          fee_quote: {
            version: 1,
            fee_bps: 10,
            min_fee_micro_usdc: 50000,
            amount_micro_usdc: 25_000_000,
            fee_micro_usdc: 50000,
            fee_recipient: 'railgun:fee',
          },
          provider_id: 'mock_attested',
          executed_at: '2026-05-25T00:00:00.000Z',
          tx_ref: 'shielded:intent_1',
          public_fallback_used: false,
          signature: 'abc',
        },
      }),
      { status: 201, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;

  try {
    const client = new GholaPrivateExecutionClient({
      baseUrl: 'https://ghola.test',
      apiKey: 'sk_agent',
    });
    const receipt = await client.executePrivateIntent({
      version: 1,
      intent_id: 'intent_1',
      owner_did: 'did:key:z6Mk',
      policy_hash: 'policy',
      proposal_hash: 'proposal',
      amount_micro_usdc: 25_000_000,
      rail: 'railgun_private_swap',
      encrypted_intent_bundle: {
        alg: 'sealed-provider-v1',
        ciphertext: 'sealed',
        recipient: 'provider',
        aad: 'aad',
      },
    });

    assert.equal(receipt.agent_id, 'agent_1');
    assert.equal(receipt.public_fallback_used, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
