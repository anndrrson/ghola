#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Ghola Live Demo: Real Agent Commerce
# ═══════════════════════════════════════════════════════════════
#
# This runs a REAL headless merchant + a REAL AI agent doing
# commerce through Ghola's protocol.
#
# 1. Starts a text analysis merchant (FastAPI)
# 2. Merchant registers itself on Ghola
# 3. Claude agent discovers the merchant via Ghola
# 4. Agent verifies the merchant's trust score
# 5. Agent calls the merchant's API
# 6. Usage is metered through Ghola
#
# Requirements:
#   - ANTHROPIC_API_KEY env var set
#   - Python 3.10+
#   - pip install fastapi uvicorn httpx anthropic
#
# Usage:
#   ANTHROPIC_API_KEY=sk-... ./demo/run-live-demo.sh
#
# ═══════════════════════════════════════════════════════════════

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GHOLA_API="${GHOLA_API_URL:-https://ghola-api.onrender.com/v1}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

echo ""
echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Ghola Live Demo: Real Agent Commerce${NC}"
echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  Ghola API: ${CYAN}${GHOLA_API}${NC}"
echo ""

# Check requirements
if [ -z "$ANTHROPIC_API_KEY" ]; then
    echo -e "${RED}Error: ANTHROPIC_API_KEY is required${NC}"
    echo "  export ANTHROPIC_API_KEY=sk-..."
    exit 1
fi

# Install dependencies if needed
echo -e "${YELLOW}[setup]${NC} Installing dependencies..."
pip install -q fastapi uvicorn httpx anthropic 2>/dev/null || {
    echo -e "${RED}Failed to install dependencies. Run: pip install fastapi uvicorn httpx anthropic${NC}"
    exit 1
}

# ─── Start the Merchant ───
echo ""
echo -e "${YELLOW}[1/3]${NC} ${BOLD}Starting headless merchant (Text Analysis API)...${NC}"
GHOLA_API_URL="$GHOLA_API" python "$SCRIPT_DIR/merchant/main.py" &
MERCHANT_PID=$!

# Cleanup on exit
trap "echo ''; echo -e '${YELLOW}[cleanup]${NC} Stopping merchant...'; kill $MERCHANT_PID 2>/dev/null; exit" EXIT INT TERM

# Wait for merchant to register on Ghola
echo -e "  Waiting for merchant to register..."
sleep 5

# Check if merchant is running
if ! kill -0 $MERCHANT_PID 2>/dev/null; then
    echo -e "${RED}Merchant failed to start${NC}"
    exit 1
fi

# Verify merchant is serving
echo -e "  Checking merchant health..."
HEALTH=$(curl -s http://localhost:8000/health 2>/dev/null)
if echo "$HEALTH" | grep -q "healthy"; then
    echo -e "  ${GREEN}✓ Merchant is running${NC}"
else
    echo -e "  ${YELLOW}⚠ Merchant health check failed (continuing anyway)${NC}"
fi

# ─── Run the Agent ───
echo ""
echo -e "${YELLOW}[2/3]${NC} ${BOLD}Launching AI agent (Claude) to discover and use the merchant...${NC}"
echo ""

GHOLA_API_URL="$GHOLA_API" python "$SCRIPT_DIR/agent/main.py" \
    "Find a text analysis service on the Ghola marketplace, check its trust score, and use it to analyze the following text for readability and complexity"

# ─── Summary ───
echo ""
echo -e "${YELLOW}[3/3]${NC} ${BOLD}Checking Ghola for recorded activity...${NC}"

# Check if the service is visible in the registry
echo -e "  Checking service registry..."
SERVICES=$(curl -s "$GHOLA_API/services?q=text+analysis" 2>/dev/null)
COUNT=$(echo "$SERVICES" | python3 -c "import json,sys; print(json.load(sys.stdin).get('total', 0))" 2>/dev/null || echo "?")
echo -e "  ${GREEN}Services matching 'text analysis': ${COUNT}${NC}"

echo ""
echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}${BOLD}  Live Demo Complete${NC}"
echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${BOLD}What just happened:${NC}"
echo -e "  1. A headless merchant registered its API on Ghola"
echo -e "  2. Claude autonomously discovered it via natural language search"
echo -e "  3. Claude checked the merchant's trust score"
echo -e "  4. Claude called the merchant's API and got results"
echo -e "  5. Usage was metered through Ghola's billing system"
echo ""
echo -e "  ${BOLD}This is agent commerce through the Ghola protocol.${NC}"
echo ""
