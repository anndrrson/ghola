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

echo "1/6 Creating Consumer Pro product..."
CONSUMER_PRO_PRODUCT=$(curl -s -X POST "$STRIPE/products" \
  -u "$SK:" \
  -d "name=Ghola Consumer Pro" \
  -d "description=10,000 API calls/day, 5 profiles, analytics" \
  -d "metadata[ghola_tier]=consumer_pro" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "   Product: $CONSUMER_PRO_PRODUCT"

echo "2/6 Creating Consumer Pro price ($9/mo)..."
CONSUMER_PRO_PRICE=$(curl -s -X POST "$STRIPE/prices" \
  -u "$SK:" \
  -d "product=$CONSUMER_PRO_PRODUCT" \
  -d "unit_amount=900" \
  -d "currency=usd" \
  -d "recurring[interval]=month" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "   Price: $CONSUMER_PRO_PRICE"

echo "3/6 Creating Business product..."
BUSINESS_PRODUCT=$(curl -s -X POST "$STRIPE/products" \
  -u "$SK:" \
  -d "name=Ghola Business" \
  -d "description=50,000 API calls/day, 20 profiles, analytics, priority support" \
  -d "metadata[ghola_tier]=business" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "   Product: $BUSINESS_PRODUCT"

echo "4/6 Creating Business price ($29/mo)..."
BUSINESS_PRICE=$(curl -s -X POST "$STRIPE/prices" \
  -u "$SK:" \
  -d "product=$BUSINESS_PRODUCT" \
  -d "unit_amount=2900" \
  -d "currency=usd" \
  -d "recurring[interval]=month" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "   Price: $BUSINESS_PRICE"

echo "5/6 Creating Private Agent product..."
PRIVATE_AGENT_PRODUCT=$(curl -s -X POST "$STRIPE/products" \
  -u "$SK:" \
  -d "name=Ghola Private Agent" \
  -d "description=Live secure worker, 60 private compute hours/month, 1 active confidential agent" \
  -d "metadata[ghola_tier]=private_agent" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "   Product: $PRIVATE_AGENT_PRODUCT"

echo "6/6 Creating Private Agent price ($49/mo)..."
PRIVATE_AGENT_PRICE=$(curl -s -X POST "$STRIPE/prices" \
  -u "$SK:" \
  -d "product=$PRIVATE_AGENT_PRODUCT" \
  -d "unit_amount=4900" \
  -d "currency=usd" \
  -d "recurring[interval]=month" \
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
echo "  STRIPE_SECRET_KEY=$SK"
echo "  STRIPE_WEBHOOK_SECRET=$WEBHOOK_SECRET"
echo "  STRIPE_PRICE_PRO=$CONSUMER_PRO_PRICE"
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
