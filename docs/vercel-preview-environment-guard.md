# Vercel Preview environment guard

`vercel env pull` deliberately returns `[SENSITIVE]` for an opaque value. That
text proves only that the key exists. It is not the secret, must never be
copied, and cannot prove value parity.

Before copying a Preview environment:

1. Select an explicit key allowlist.
2. Load values from an authoritative, materialized source such as the secret
   manager or a freshly generated rotation file—not another opaque Vercel pull.
3. Validate the complete source before the first write. Do not partially copy
   when any allowlisted value is missing or opaque.
4. Verify the resulting deployment with its runtime authorization check.
   Pulling the target again cannot prove parity for sensitive values.

For two materialized snapshots:

```sh
cd apps/web
pnpm run preview:verify-env-parity -- \
  /secure/reference.env \
  /secure/candidate.env
```

The guard fails closed on empty values, `[SENSITIVE]`, other recognized opaque
markers, duplicate keys, missing or unexpected keys, whitespace drift, and
value mismatch. It prints key names and counts, never values.

Copy automation must import `copyVerifiedPreviewEnv` from
`apps/web/scripts/verify-preview-env-parity.mjs` and provide an explicit key
allowlist plus the write callback. The complete source is validated before the
first callback, so any missing or opaque value produces zero writes.

The Vercel pre-build private-worker check uses the same opaque-value guard. A
placeholder in worker URLs, authorization, image pins, or signer pins fails
before any worker authorization probe.
