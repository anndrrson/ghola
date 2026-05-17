"""
Ghola Demo: AI Agent — Autonomous Service Discovery & Commerce

A real AI agent (powered by Claude) that:
1. Searches Ghola's service registry for a merchant that can handle the task
2. Inspects the merchant's details, pricing, and SLA
3. Checks the merchant's trust/reputation score
4. Calls the merchant's API
5. Reports the result

This is the proof that agent commerce works through Ghola.

Usage:
    ANTHROPIC_API_KEY=sk-... python main.py "Analyze this text for readability"

    # With custom Ghola API:
    GHOLA_API_URL=http://localhost:8080/v1 ANTHROPIC_API_KEY=sk-... python main.py "..."
"""

import os
import sys
import json

import httpx
import anthropic

GHOLA_API = os.environ.get("GHOLA_API_URL", "https://ghola-api.onrender.com/v1")
CLAUDE_MODEL = os.environ.get("CLAUDE_MODEL", "claude-sonnet-4-20250514")

# Colors for terminal output
BLUE = "\033[94m"
GREEN = "\033[92m"
YELLOW = "\033[93m"
CYAN = "\033[96m"
BOLD = "\033[1m"
DIM = "\033[2m"
RESET = "\033[0m"

# ── Tool Definitions ──

TOOLS = [
    {
        "name": "search_services",
        "description": "Search Ghola's service registry for headless merchants that can handle a task. Returns ranked services with pricing and reliability info.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Natural language description of what you need (e.g. 'text analysis', 'image generation', 'weather forecast')",
                },
                "max_price_usdc": {
                    "type": "number",
                    "description": "Maximum price per request in USDC (e.g. 0.01)",
                },
            },
            "required": ["query"],
        },
    },
    {
        "name": "get_service_details",
        "description": "Get full details about a specific service including endpoints, pricing tiers, SLA guarantees, and authentication requirements.",
        "input_schema": {
            "type": "object",
            "properties": {
                "slug": {
                    "type": "string",
                    "description": "The service slug (URL-safe identifier)",
                },
            },
            "required": ["slug"],
        },
    },
    {
        "name": "check_trust_score",
        "description": "Check the reputation and trust score of a service provider. Returns composite score (0-1), transaction history, completion rate, and review ratings.",
        "input_schema": {
            "type": "object",
            "properties": {
                "did": {
                    "type": "string",
                    "description": "The DID (decentralized identifier) of the service provider",
                },
            },
            "required": ["did"],
        },
    },
    {
        "name": "call_service",
        "description": "Call a headless merchant's API endpoint. Send a request and get the response.",
        "input_schema": {
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "Full URL of the API endpoint",
                },
                "method": {
                    "type": "string",
                    "description": "HTTP method (GET or POST)",
                    "default": "POST",
                },
                "body": {
                    "type": "object",
                    "description": "Request body (for POST requests)",
                },
            },
            "required": ["url"],
        },
    },
]

# ── Tool Implementations ──


def search_services(query: str, max_price_usdc: float = None) -> dict:
    """Search Ghola for services matching the query."""
    params = {"task": query, "limit": "5"}
    if max_price_usdc:
        params["max_price_micro_usdc"] = str(int(max_price_usdc * 1_000_000))

    with httpx.Client(timeout=15) as client:
        resp = client.get(f"{GHOLA_API}/services/resolve", params=params)

        # Show pricing headers
        price_header = resp.headers.get("x-price-micro-usdc")
        if price_header:
            print(f"  {DIM}[pricing header] X-Price-Micro-USDC: {price_header}{RESET}")

        if resp.status_code != 200:
            return {"error": f"Search failed: {resp.status_code}", "body": resp.text[:200]}
        return resp.json()


def get_service_details(slug: str) -> dict:
    """Get full details for a service."""
    with httpx.Client(timeout=15) as client:
        resp = client.get(f"{GHOLA_API}/services/{slug}")
        if resp.status_code != 200:
            return {"error": f"Not found: {resp.status_code}"}
        return resp.json()


def check_trust_score(did: str) -> dict:
    """Get reputation score for a DID."""
    with httpx.Client(timeout=15) as client:
        resp = client.get(f"{GHOLA_API}/reputation/{did}")
        if resp.status_code != 200:
            return {"error": f"Reputation lookup failed: {resp.status_code}"}
        return resp.json()


def call_service(url: str, method: str = "POST", body: dict = None) -> dict:
    """Call a headless merchant's API."""
    with httpx.Client(timeout=30) as client:
        if method.upper() == "GET":
            resp = client.get(url)
        else:
            resp = client.post(url, json=body or {})

        return {
            "status_code": resp.status_code,
            "headers": {
                k: v for k, v in resp.headers.items()
                if k.lower().startswith("x-") or k.lower() == "content-type"
            },
            "body": resp.json() if "json" in resp.headers.get("content-type", "") else resp.text[:500],
        }


def execute_tool(name: str, input_data: dict) -> str:
    """Execute a tool and return the result as a JSON string."""
    print(f"  {CYAN}[tool] {name}({json.dumps(input_data, indent=None)[:100]}){RESET}")

    if name == "search_services":
        result = search_services(**input_data)
    elif name == "get_service_details":
        result = get_service_details(**input_data)
    elif name == "check_trust_score":
        result = check_trust_score(**input_data)
    elif name == "call_service":
        result = call_service(**input_data)
    else:
        result = {"error": f"Unknown tool: {name}"}

    # Print a summary of the result
    if isinstance(result, dict):
        if "services" in result:
            services = result["services"]
            print(f"  {GREEN}[result] Found {len(services)} services{RESET}")
            for s in services[:3]:
                price = s.get("price_micro_usdc", 0) / 1_000_000
                print(f"    → {s.get('name', '?')} ({s.get('slug', '?')}) — ${price:.4f}/call")
        elif "service" in result:
            svc = result["service"]
            print(f"  {GREEN}[result] {svc.get('name', '?')} — status: {svc.get('status', '?')}{RESET}")
        elif "overall_score" in result:
            print(f"  {GREEN}[result] Trust score: {result['overall_score']:.2f} (confidence: {result.get('confidence', 0):.2f}){RESET}")
        elif "status_code" in result:
            print(f"  {GREEN}[result] HTTP {result['status_code']}{RESET}")
        elif "error" in result:
            print(f"  {YELLOW}[result] Error: {result['error']}{RESET}")

    return json.dumps(result, default=str)


# ── Agent Loop ──


def run_agent(task: str, sample_text: str = None):
    """Run the Claude agent with Ghola tools."""
    client = anthropic.Anthropic()

    system_prompt = f"""You are an AI agent that discovers and uses headless merchant APIs through the Ghola protocol.

Your workflow:
1. Search for services that can handle the user's task using search_services
2. Pick the best service based on price, rating, and uptime
3. Get full details about the service using get_service_details
4. Check the merchant's trust score using check_trust_score
5. Call the service's API endpoint using call_service
6. Report the results back to the user

Always check pricing and trust before calling a service. Prefer services with higher trust scores and better uptime.

The Ghola API is at: {GHOLA_API}
You are operating in the agentic commerce economy. Every API call has a price. Be efficient."""

    user_message = task
    if sample_text:
        user_message += f"\n\nHere is the text to analyze:\n\n{sample_text}"

    messages = [{"role": "user", "content": user_message}]

    print(f"\n{BOLD}{'='*60}{RESET}")
    print(f"{BOLD}  Ghola Agent — Autonomous Service Discovery & Commerce{RESET}")
    print(f"{BOLD}{'='*60}{RESET}")
    print(f"\n{YELLOW}Task:{RESET} {task}\n")

    # Agent loop — keep going until Claude stops using tools
    step = 0
    while True:
        step += 1
        print(f"{BLUE}[step {step}]{RESET} Thinking...")

        response = client.messages.create(
            model=CLAUDE_MODEL,
            max_tokens=1024,
            system=system_prompt,
            tools=TOOLS,
            messages=messages,
        )

        # Check if Claude wants to use tools
        tool_uses = [b for b in response.content if b.type == "tool_use"]
        text_blocks = [b for b in response.content if b.type == "text"]

        # Print any text output
        for block in text_blocks:
            if block.text.strip():
                print(f"\n{GREEN}[agent]{RESET} {block.text}")

        # If no tool uses, we're done
        if not tool_uses:
            break

        # Execute each tool
        tool_results = []
        for tool_use in tool_uses:
            result = execute_tool(tool_use.name, tool_use.input)
            tool_results.append({
                "type": "tool_result",
                "tool_use_id": tool_use.id,
                "content": result,
            })

        # Send results back to Claude
        messages.append({"role": "assistant", "content": response.content})
        messages.append({"role": "user", "content": tool_results})

    print(f"\n{BOLD}{'='*60}{RESET}")
    print(f"{GREEN}{BOLD}  Agent completed in {step} steps{RESET}")
    print(f"{BOLD}{'='*60}{RESET}\n")


# ── Main ──

if __name__ == "__main__":
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("Error: ANTHROPIC_API_KEY environment variable is required")
        print("Usage: ANTHROPIC_API_KEY=sk-... python main.py \"your task\"")
        sys.exit(1)

    # Default task and sample text
    if len(sys.argv) > 1:
        task = " ".join(sys.argv[1:])
    else:
        task = "Find a text analysis service, check its trust score, and analyze this text for readability"

    sample_text = """The Machine Payments Protocol represents a fundamental shift in how
commerce operates on the internet. Rather than requiring human-mediated checkout flows,
subscription management, and account creation, MPP enables AI agents to discover services,
evaluate their pricing and reliability, and transact in a single HTTP request. This
eliminates the traditional overhead of customer acquisition, billing infrastructure, and
relationship management that has defined software businesses for decades. The implications
are profound: any API with predictable pricing and reliable output can now operate as a
fully autonomous business, serving thousands of agent customers without ever interacting
with a human buyer."""

    run_agent(task, sample_text)
