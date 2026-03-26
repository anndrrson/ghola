#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Ghola End-to-End Demo: Headless Merchant Economy
# ═══════════════════════════════════════════════════════════════
#
# This script demonstrates the full agent commerce flow:
# 1. Register a merchant account
# 2. Register a headless merchant service with pricing
# 3. Create a service API key
# 4. An "agent" discovers the service
# 5. The agent verifies identity via SAID
# 6. The agent's usage is metered
# 7. Check reputation scores
# 8. Show pricing headers on every response
#
# Usage: ./demo/run-demo.sh [API_URL]
# Default API_URL: http://localhost:8080/v1

set -e

API="${1:-http://localhost:8080/v1}"
BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'
BOLD='\033[1m'

TIMESTAMP=$(date +%s)
MERCHANT_EMAIL="demo-merchant-${TIMESTAMP}@ghola.xyz"
AGENT_EMAIL="demo-agent-${TIMESTAMP}@ghola.xyz"
PASSWORD="demo-password-123"
SLUG="demo-weather-api-${TIMESTAMP}"

echo ""
echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Ghola Demo: Headless Merchant Economy — End to End${NC}"
echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  API: ${CYAN}${API}${NC}"
echo ""

# ─── Step 0: Health Check ───
echo -e "${YELLOW}[0/8]${NC} ${BOLD}Health check...${NC}"
HEALTH=$(curl -s "${API%/v1}/health")
echo "$HEALTH" | python3 -m json.tool 2>/dev/null || echo "$HEALTH"
echo ""

# ─── Step 1: Pricing Catalog ───
echo -e "${YELLOW}[1/8]${NC} ${BOLD}Fetching pricing catalog (what agents see first)...${NC}"
echo -e "  ${CYAN}GET /v1/pricing${NC}"
PRICING=$(curl -s "$API/pricing")
echo "$PRICING" | python3 -c "
import json, sys
data = json.load(sys.stdin)
print(f\"  Protocol: {data['protocol']}\")
print(f\"  Currency: {data['currency']}\")
print(f\"  Endpoints: {data['total_endpoints']}\")
print()
for ep in data['endpoints'][:4]:
    price = ep['price_micro_usdc'] / 1_000_000
    print(f\"    {ep['method']:4s} {ep['path']:<35s} \${price:.4f}/call  (free: {ep['free_tier_per_day']}/day)\")
print(f\"    ... and {len(data['endpoints']) - 4} more\")
" 2>/dev/null
echo ""

# ─── Step 2: Register Merchant ───
echo -e "${YELLOW}[2/8]${NC} ${BOLD}Registering merchant account...${NC}"
echo -e "  ${CYAN}POST /v1/auth/register${NC}  (${MERCHANT_EMAIL})"
REGISTER=$(curl -s -X POST "$API/auth/register" \
  -H "Content-Type: application/json" \
  -d "{
    \"email\": \"${MERCHANT_EMAIL}\",
    \"password\": \"${PASSWORD}\",
    \"account_type\": \"business\",
    \"business_name\": \"Demo Weather API\",
    \"category\": \"data\"
  }")
MERCHANT_TOKEN=$(echo "$REGISTER" | python3 -c "import json,sys; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)

if [ -z "$MERCHANT_TOKEN" ]; then
  echo -e "  ${GREEN}Registration response:${NC}"
  echo "$REGISTER" | python3 -m json.tool 2>/dev/null || echo "$REGISTER"
  echo -e "  ${YELLOW}(Token extraction failed — this is OK if server isn't running locally)${NC}"
  echo ""
  echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
  echo -e "${BOLD}  Demo requires a running server. Start with:${NC}"
  echo -e "${BOLD}  cargo run -p said-cloud${NC}"
  echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
  exit 1
fi
echo -e "  ${GREEN}✓ Merchant registered, JWT obtained${NC}"
echo ""

# ─── Step 3: Register a Headless Merchant Service ───
echo -e "${YELLOW}[3/8]${NC} ${BOLD}Registering headless merchant service...${NC}"
echo -e "  ${CYAN}POST /v1/services/register${NC}  (slug: ${SLUG})"
SERVICE=$(curl -s -X POST "$API/services/register" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${MERCHANT_TOKEN}" \
  -d "{
    \"name\": \"Demo Weather Forecast API\",
    \"slug\": \"${SLUG}\",
    \"description\": \"Real-time weather forecasts for any location. Per-request pricing. No account needed.\",
    \"category\": \"data\",
    \"tags\": [\"weather\", \"forecast\", \"data\", \"geolocation\"],
    \"base_url\": \"https://api.example-weather.com\",
    \"auth_type\": \"none\",
    \"pricing_model\": \"per_request\",
    \"price_micro_usdc\": 3000,
    \"free_tier_requests\": 50,
    \"sla_uptime_percent\": 99.5,
    \"regions\": [\"us-east\", \"eu-west\"],
    \"endpoints\": [{
      \"name\": \"forecast\",
      \"path\": \"/v1/forecast\",
      \"method\": \"GET\",
      \"description\": \"Get 7-day forecast for a location\",
      \"request_schema\": {\"type\": \"object\", \"properties\": {\"lat\": {\"type\": \"number\"}, \"lon\": {\"type\": \"number\"}}},
      \"response_schema\": {\"type\": \"object\", \"properties\": {\"forecast\": {\"type\": \"array\"}}},
      \"price_micro_usdc\": 3000
    }]
  }")

SERVICE_ID=$(echo "$SERVICE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
echo -e "  ${GREEN}✓ Service registered: ${SERVICE_ID}${NC}"
echo -e "  Price: \$0.003/request | Free tier: 50/day | SLA: 99.5% uptime"
echo ""

# ─── Step 4: Create Service API Key ───
echo -e "${YELLOW}[4/8]${NC} ${BOLD}Creating service API key (for verification endpoint)...${NC}"
echo -e "  ${CYAN}POST /v1/service-keys${NC}"
KEY_RESP=$(curl -s -X POST "$API/service-keys" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${MERCHANT_TOKEN}" \
  -d "{
    \"service_id\": \"${SERVICE_ID}\",
    \"name\": \"demo-key\",
    \"scopes\": [\"verify\", \"meter\"]
  }")
SERVICE_KEY=$(echo "$KEY_RESP" | python3 -c "import json,sys; print(json.load(sys.stdin).get('key',''))" 2>/dev/null)
echo -e "  ${GREEN}✓ API key created: ${SERVICE_KEY:0:20}...${NC}"
echo ""

# ─── Step 5: Agent Discovers the Service ───
echo -e "${YELLOW}[5/8]${NC} ${BOLD}Agent searches for weather services...${NC}"
echo -e "  ${CYAN}GET /v1/services/resolve?task=weather+forecast${NC}"
echo ""
RESOLVE=$(curl -s -D /tmp/ghola-headers.txt "$API/services/resolve?task=weather+forecast")

# Show pricing headers
echo -e "  ${BLUE}Response Headers (pricing):${NC}"
grep -i "x-price\|x-currency\|x-free\|x-pricing\|x-payment" /tmp/ghola-headers.txt 2>/dev/null | while read line; do
  echo -e "    ${CYAN}${line}${NC}"
done
echo ""

FOUND=$(echo "$RESOLVE" | python3 -c "
import json, sys
data = json.load(sys.stdin)
services = data.get('services', [])
print(len(services))
for s in services[:3]:
    price = s['price_micro_usdc'] / 1_000_000
    print(f\"    → {s['name']} ({s['slug']}) — \${price:.4f}/call — uptime: {s['uptime_percent']}%\")
" 2>/dev/null)
echo -e "  ${GREEN}Found services:${NC}"
echo "$FOUND" | tail -n +2
echo ""

# ─── Step 6: Agent Gets Service Details ───
echo -e "${YELLOW}[6/8]${NC} ${BOLD}Agent inspects service details...${NC}"
echo -e "  ${CYAN}GET /v1/services/${SLUG}${NC}"
DETAIL=$(curl -s "$API/services/${SLUG}")
echo "$DETAIL" | python3 -c "
import json, sys
data = json.load(sys.stdin)
svc = data.get('service', {})
price = svc.get('price_micro_usdc', 0) / 1_000_000
print(f\"  Name:     {svc.get('name')}\")
print(f\"  Category: {svc.get('category')}\")
print(f\"  Price:    \${price:.4f}/request\")
print(f\"  Auth:     {svc.get('auth_type')}\")
print(f\"  Base URL: {svc.get('base_url')}\")
print(f\"  Status:   {svc.get('status')}\")
eps = svc.get('endpoints', [])
if eps:
    print(f\"  Endpoints:\")
    for ep in eps:
        print(f\"    {ep.get('method','GET')} {ep.get('path','')} — {ep.get('description','')}\")
" 2>/dev/null
echo ""

# ─── Step 7: Merchant Verifies an Agent ───
echo -e "${YELLOW}[7/8]${NC} ${BOLD}Merchant verifies an agent's identity via SAID...${NC}"

# First register an agent account
AGENT_REG=$(curl -s -X POST "$API/auth/register" \
  -H "Content-Type: application/json" \
  -d "{
    \"email\": \"${AGENT_EMAIL}\",
    \"password\": \"${PASSWORD}\",
    \"account_type\": \"consumer\",
    \"display_name\": \"Demo Agent Bot\"
  }")
AGENT_TOKEN=$(echo "$AGENT_REG" | python3 -c "import json,sys; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)

# Get agent's DID
AGENT_PROFILE=$(curl -s "$API/consumer/profile" -H "Authorization: Bearer ${AGENT_TOKEN}")
AGENT_DID=$(echo "$AGENT_PROFILE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('did','unknown'))" 2>/dev/null)

echo -e "  ${CYAN}POST /v1/verify/agent${NC}  (X-Service-Key auth)"
VERIFY=$(curl -s -X POST "$API/verify/agent" \
  -H "Content-Type: application/json" \
  -H "X-Service-Key: ${SERVICE_KEY}" \
  -d "{
    \"agent_did\": \"${AGENT_DID}\"
  }")
echo "$VERIFY" | python3 -c "
import json, sys
data = json.load(sys.stdin)
print(f\"  Valid:        {data.get('valid')}\")
print(f\"  Agent DID:    {data.get('agent_did', 'N/A')[:40]}...\")
print(f\"  Profile:      {data.get('profile_type', 'none')}\")
print(f\"  Display Name: {data.get('display_name', 'N/A')}\")
print(f\"  Trust Score:  {data.get('trust_score', 0):.2f}\")
print(f\"  On-Chain:     {data.get('on_chain_registered', False)}\")
print(f\"  Verified:     {data.get('verified_badge', False)}\")
" 2>/dev/null
echo ""

# ─── Step 8: Meter Usage ───
echo -e "${YELLOW}[8/8]${NC} ${BOLD}Metering agent's API usage (billing-as-a-service)...${NC}"
echo -e "  ${CYAN}POST /v1/meter${NC}  (X-Service-Key auth)"
METER=$(curl -s -X POST "$API/meter" \
  -H "Content-Type: application/json" \
  -H "X-Service-Key: ${SERVICE_KEY}" \
  -d "{
    \"agent_did\": \"${AGENT_DID}\",
    \"endpoint_name\": \"forecast\",
    \"request_count\": 1
  }")
echo "$METER" | python3 -c "
import json, sys
data = json.load(sys.stdin)
amount = data.get('amount_micro_usdc', 0) / 1_000_000
print(f\"  Metered:  {data.get('metered')}\")
print(f\"  Amount:   \${amount:.4f} USDC\")
print(f\"  Service:  {data.get('service_id', 'N/A')[:8]}...\")
" 2>/dev/null
echo ""

# ─── Summary ───
echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}${BOLD}  Demo Complete — Full Agent Commerce Flow${NC}"
echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${BOLD}What just happened:${NC}"
echo -e "  1. Merchant registered an API service with per-request pricing"
echo -e "  2. Agent discovered it via full-text search"
echo -e "  3. Pricing headers included in every response"
echo -e "  4. Agent inspected endpoints, pricing, SLA"
echo -e "  5. Merchant verified the agent's identity via SAID"
echo -e "  6. Agent's usage was metered at \$0.003/call"
echo ""
echo -e "  ${BOLD}No accounts. No checkout. No subscription.${NC}"
echo -e "  ${BOLD}Just an API, a price, and a payment.${NC}"
echo ""
echo -e "  ${CYAN}Pricing catalog:${NC}  ${API}/pricing"
echo -e "  ${CYAN}Marketplace:${NC}      ${API%/v1}/marketplace"
echo -e "  ${CYAN}Service detail:${NC}   ${API}/services/${SLUG}"
echo ""
