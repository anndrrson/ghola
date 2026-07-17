#!/usr/bin/env bash
set -euo pipefail

# Ghola Stripe Setup Script
# Creates products, prices, and webhook endpoint via Stripe API
#
# Usage: STRIPE_SECRET_KEY=sk_live_xxx ./scripts/setup-stripe.sh <api_url>
# Example: STRIPE_SECRET_KEY=sk_live_xxx ./scripts/setup-stripe.sh https://api.ghola.xyz

API_URL="${1:-}"
WEBHOOK_PATH="${STRIPE_WEBHOOK_PATH:-/api/billing/webhook}"
if [ -z "$API_URL" ]; then
  echo "Usage: STRIPE_SECRET_KEY=sk_live_xxx $0 <api_url>"
  echo "Example: STRIPE_SECRET_KEY=sk_live_xxx $0 https://api.ghola.xyz"
  exit 1
fi

if [ -z "${STRIPE_SECRET_KEY:-}" ]; then
  echo "Error: STRIPE_SECRET_KEY environment variable is required"
  echo "Get it from: https://dashboard.stripe.com/apikeys"
  exit 1
fi

SK="$STRIPE_SECRET_KEY"
STRIPE="https://api.stripe.com/v1"

echo "Setting up Stripe for Ghola..."
echo "API URL: $API_URL"
echo ""

# --- Step 1: Create Products ---

echo "1/10 Creating Consumer Pro product..."
CONSUMER_PRO_PRODUCT=$(curl -s -X POST "$STRIPE/products" \
  -u "$SK:" \
  -d "name=Ghola Consumer Pro" \
  -d "description=10,000 API calls/day, 5 profiles, analytics" \
  -d "metadata[ghola_tier]=consumer_pro" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "   Product: $CONSUMER_PRO_PRODUCT"

echo "2/10 Creating Consumer Pro price ($9/mo)..."
CONSUMER_PRO_PRICE=$(curl -s -X POST "$STRIPE/prices" \
  -u "$SK:" \
  -d "product=$CONSUMER_PRO_PRODUCT" \
  -d "unit_amount=900" \
  -d "currency=usd" \
  -d "recurring[interval]=month" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "   Price: $CONSUMER_PRO_PRICE"

echo "3/10 Creating Business product..."
BUSINESS_PRODUCT=$(curl -s -X POST "$STRIPE/products" \
  -u "$SK:" \
  -d "name=Ghola Business" \
  -d "description=50,000 API calls/day, 20 profiles, analytics, priority support" \
  -d "metadata[ghola_tier]=business" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "   Product: $BUSINESS_PRODUCT"

echo "4/10 Creating Business price ($29/mo)..."
BUSINESS_PRICE=$(curl -s -X POST "$STRIPE/prices" \
  -u "$SK:" \
  -d "product=$BUSINESS_PRODUCT" \
  -d "unit_amount=2900" \
  -d "currency=usd" \
  -d "recurring[interval]=month" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "   Price: $BUSINESS_PRICE"

echo "5/10 Creating Private Agent Trial Pack product..."
PRIVATE_AGENT_TRIAL_PRODUCT=$(curl -s -X POST "$STRIPE/products" \
  -u "$SK:" \
  -d "name=Ghola Private Agent Trial Pack" \
  -d "description=5 secure private compute hours and $10,000 included filled notional, valid for 14 days" \
  -d "metadata[ghola_tier]=trial_pack" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "   Product: $PRIVATE_AGENT_TRIAL_PRODUCT"

echo "6/10 Creating Private Agent Trial Pack price ($9 one-time)..."
PRIVATE_AGENT_TRIAL_PRICE=$(curl -s -X POST "$STRIPE/prices" \
  -u "$SK:" \
  -d "product=$PRIVATE_AGENT_TRIAL_PRODUCT" \
  -d "lookup_key=ghola_private_agent_trial_pack_v1" \
  -d "unit_amount=900" \
  -d "currency=usd" \
  -d "metadata[ghola_plan]=trial_pack" \
  -d "metadata[tier]=trial_pack" \
  -d "metadata[included_compute_seconds]=18000" \
  -d "metadata[expires_days]=14" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "   Price: $PRIVATE_AGENT_TRIAL_PRICE"

echo "7/10 Creating Private Agent Starter product..."
PRIVATE_AGENT_STARTER_PRODUCT=$(curl -s -X POST "$STRIPE/products" \
  -u "$SK:" \
  -d "name=Ghola Starter Agent" \
  -d "description=Live secure worker, 20 private compute hours/month, $100,000 included filled notional, then 3 bps" \
  -d "metadata[ghola_tier]=starter" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "   Product: $PRIVATE_AGENT_STARTER_PRODUCT"

echo "8/10 Creating Private Agent Starter price ($39/mo)..."
PRIVATE_AGENT_STARTER_PRICE=$(curl -s -X POST "$STRIPE/prices" \
  -u "$SK:" \
  -d "product=$PRIVATE_AGENT_STARTER_PRODUCT" \
  -d "lookup_key=ghola_private_agent_starter_v2" \
  -d "unit_amount=3900" \
  -d "currency=usd" \
  -d "recurring[interval]=month" \
  -d "metadata[ghola_plan]=starter" \
  -d "metadata[tier]=starter" \
  -d "metadata[included_compute_seconds]=72000" \
  -d "metadata[included_notional_micro_usd]=100000000000" \
  -d "metadata[overage_fee_bps]=3" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "   Price: $PRIVATE_AGENT_STARTER_PRICE"

echo "9/10 Creating Private Agent product..."
PRIVATE_AGENT_PRODUCT=$(curl -s -X POST "$STRIPE/products" \
  -u "$SK:" \
  -d "name=Ghola Private Agent" \
  -d "description=Live secure worker, 80 private compute hours/month, $1,000,000 included filled notional, then 2 bps" \
  -d "metadata[ghola_tier]=private_agent" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "   Product: $PRIVATE_AGENT_PRODUCT"

echo "10/10 Creating Private Agent price ($129/mo)..."
PRIVATE_AGENT_PRICE=$(curl -s -X POST "$STRIPE/prices" \
  -u "$SK:" \
  -d "product=$PRIVATE_AGENT_PRODUCT" \
  -d "lookup_key=ghola_private_agent_v2" \
  -d "unit_amount=12900" \
  -d "currency=usd" \
  -d "recurring[interval]=month" \
  -d "metadata[ghola_plan]=private_agent" \
  -d "metadata[tier]=private_agent" \
  -d "metadata[included_compute_seconds]=288000" \
  -d "metadata[included_notional_micro_usd]=1000000000000" \
  -d "metadata[overage_fee_bps]=2" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "   Price: $PRIVATE_AGENT_PRICE"

# --- Step 2: Create Webhook Endpoint ---

echo "Creating webhook endpoint..."
WEBHOOK_RESULT=$(curl -s -X POST "$STRIPE/webhook_endpoints" \
  -u "$SK:" \
  -d "url=$API_URL$WEBHOOK_PATH" \
  -d "enabled_events[]=checkout.session.completed" \
  -d "enabled_events[]=customer.subscription.updated" \
  -d "enabled_events[]=customer.subscription.deleted" \
  -d "enabled_events[]=invoice.paid" \
  -d "enabled_events[]=invoice.payment_failed" \
  -d "description=Ghola API billing webhook")

WEBHOOK_SECRET=$(echo "$WEBHOOK_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['secret'])")
WEBHOOK_ID=$(echo "$WEBHOOK_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "   Webhook: $WEBHOOK_ID"
echo "   Secret: $WEBHOOK_SECRET"

# --- Summary ---

echo ""
echo "============================================"
echo "  Stripe setup complete!"
echo "============================================"
echo ""
echo "Set these environment variables on your API server (Render):"
echo ""
echo "  STRIPE_SECRET_KEY=<keep the live key already supplied to this script>"
echo "  STRIPE_WEBHOOK_SECRET=$WEBHOOK_SECRET"
echo "  STRIPE_PRICE_PRO=$CONSUMER_PRO_PRICE"
echo "  STRIPE_PRICE_PRIVATE_AGENT_TRIAL_PACK=$PRIVATE_AGENT_TRIAL_PRICE"
echo "  STRIPE_PRICE_PRIVATE_AGENT_STARTER=$PRIVATE_AGENT_STARTER_PRICE"
echo "  STRIPE_PRICE_PRIVATE_AGENT=$PRIVATE_AGENT_PRICE"
echo "  STRIPE_PRICE_UNLIMITED=$BUSINESS_PRICE"
echo "  STRIPE_PRICE_CONSUMER_PRO=$CONSUMER_PRO_PRICE"
echo "  STRIPE_PRICE_BUSINESS=$BUSINESS_PRICE"
echo ""
echo "Stripe Dashboard links:"
echo "  Products: https://dashboard.stripe.com/products"
echo "  Webhooks: https://dashboard.stripe.com/webhooks"
echo "  API Keys: https://dashboard.stripe.com/apikeys"
echo ""
echo "Next steps:"
echo "  1. Copy the env vars above into Thumper's production secrets"
echo "  2. Verify webhook is receiving events in Stripe Dashboard > Webhooks"
echo "  3. Test with a checkout at $API_URL/api/billing/checkout"
