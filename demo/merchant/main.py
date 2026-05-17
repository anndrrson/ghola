"""
Ghola Demo: Headless Merchant — Text Analysis API

A real headless merchant that:
1. Registers itself on Ghola's service registry on startup
2. Serves a text analysis API (word count, readability, stats)
3. Meters every request through Ghola's billing-as-a-service
4. Charges $0.002 per request in USDC

Usage:
    GHOLA_API_URL=https://ghola-api.onrender.com/v1 python main.py
"""

import os
import re
import asyncio
import math
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
import uvicorn

GHOLA_API = os.environ.get("GHOLA_API_URL", "https://ghola-api.onrender.com/v1")
PORT = int(os.environ.get("PORT", "8000"))
MERCHANT_EMAIL = os.environ.get("MERCHANT_EMAIL", f"text-analyzer-{os.getpid()}@demo.ghola.xyz")
MERCHANT_PASSWORD = os.environ.get("MERCHANT_PASSWORD", "demo-merchant-password-2026")

# State populated during startup
state = {
    "token": None,
    "service_id": None,
    "service_key": None,
    "merchant_did": None,
}


async def register_on_ghola():
    """Register this merchant on Ghola's service registry."""
    async with httpx.AsyncClient(timeout=30) as client:
        # 1. Register account
        print(f"[merchant] Registering account: {MERCHANT_EMAIL}")
        resp = await client.post(f"{GHOLA_API}/auth/register", json={
            "email": MERCHANT_EMAIL,
            "password": MERCHANT_PASSWORD,
            "account_type": "business",
            "business_name": "Text Analyzer API",
            "category": "data",
        })

        if resp.status_code == 409:
            # Already registered — login instead
            print("[merchant] Account exists, logging in...")
            resp = await client.post(f"{GHOLA_API}/auth/login", json={
                "email": MERCHANT_EMAIL,
                "password": MERCHANT_PASSWORD,
            })

        data = resp.json()
        token = data.get("token")
        if not token:
            print(f"[merchant] Auth failed: {data}")
            return False

        state["token"] = token
        headers = {"Authorization": f"Bearer {token}"}

        # 2. Register the service
        print("[merchant] Registering service: text-analyzer")
        slug = f"text-analyzer-{os.getpid()}"
        resp = await client.post(f"{GHOLA_API}/services/register", headers=headers, json={
            "name": "Text Analysis API",
            "slug": slug,
            "description": "Analyze text for word count, sentence count, readability score, and complexity metrics. Per-request pricing, no account needed.",
            "category": "data",
            "tags": ["text", "analysis", "readability", "nlp", "word-count"],
            "base_url": f"http://localhost:{PORT}",
            "auth_type": "none",
            "pricing_model": "per_request",
            "price_micro_usdc": 2000,  # $0.002
            "free_tier_requests": 50,
            "sla_uptime_percent": 99.0,
            "endpoints": [{
                "name": "analyze",
                "path": "/analyze",
                "method": "POST",
                "description": "Analyze text for readability and statistics",
                "request_schema": {
                    "type": "object",
                    "properties": {"text": {"type": "string"}},
                    "required": ["text"],
                },
                "response_schema": {
                    "type": "object",
                    "properties": {
                        "word_count": {"type": "integer"},
                        "sentence_count": {"type": "integer"},
                        "avg_word_length": {"type": "number"},
                        "reading_level": {"type": "string"},
                    },
                },
                "price_micro_usdc": 2000,
            }],
        })

        if resp.status_code in (201, 200):
            svc = resp.json()
            state["service_id"] = svc.get("id")
            print(f"[merchant] Service registered: {slug} (id: {state['service_id'][:8]}...)")
        elif resp.status_code == 409:
            print(f"[merchant] Service slug already exists, continuing...")
        else:
            print(f"[merchant] Service registration: {resp.status_code} {resp.text[:200]}")

        # 3. Create service API key
        if state["service_id"]:
            resp = await client.post(f"{GHOLA_API}/service-keys", headers=headers, json={
                "service_id": state["service_id"],
                "name": "demo-key",
                "scopes": ["verify", "meter"],
            })
            if resp.status_code == 201:
                key_data = resp.json()
                state["service_key"] = key_data.get("key")
                print(f"[merchant] API key created: {state['service_key'][:20]}...")
            else:
                print(f"[merchant] Key creation: {resp.status_code} {resp.text[:200]}")

        print(f"[merchant] Ready at http://localhost:{PORT}")
        print(f"[merchant] Pricing: $0.002/request | Free tier: 50/day")
        return True


async def meter_usage(agent_did: str = "unknown"):
    """Report usage to Ghola for billing."""
    if not state["service_key"]:
        return
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            await client.post(f"{GHOLA_API}/meter", headers={
                "X-Service-Key": state["service_key"],
            }, json={
                "agent_did": agent_did,
                "endpoint_name": "analyze",
                "request_count": 1,
            })
    except Exception as e:
        print(f"[merchant] Metering failed: {e}")


# ── Text Analysis Logic ──

def analyze_text(text: str) -> dict:
    """Analyze text for readability and statistics."""
    words = text.split()
    word_count = len(words)

    sentences = [s.strip() for s in re.split(r'[.!?]+', text) if s.strip()]
    sentence_count = max(len(sentences), 1)

    avg_word_length = sum(len(w.strip(".,!?;:\"'")) for w in words) / max(word_count, 1)

    # Flesch-Kincaid approximation
    syllable_count = sum(count_syllables(w) for w in words)
    avg_syllables = syllable_count / max(word_count, 1)
    avg_sentence_length = word_count / sentence_count

    fk_grade = 0.39 * avg_sentence_length + 11.8 * avg_syllables - 15.59
    fk_grade = max(1, min(16, fk_grade))

    if fk_grade <= 5:
        reading_level = "elementary"
    elif fk_grade <= 8:
        reading_level = "middle_school"
    elif fk_grade <= 12:
        reading_level = "high_school"
    else:
        reading_level = "college"

    unique_words = len(set(w.lower().strip(".,!?;:\"'") for w in words))
    lexical_diversity = unique_words / max(word_count, 1)

    return {
        "word_count": word_count,
        "sentence_count": sentence_count,
        "avg_word_length": round(avg_word_length, 2),
        "avg_sentence_length": round(avg_sentence_length, 2),
        "syllable_count": syllable_count,
        "flesch_kincaid_grade": round(fk_grade, 1),
        "reading_level": reading_level,
        "unique_words": unique_words,
        "lexical_diversity": round(lexical_diversity, 3),
    }


def count_syllables(word: str) -> int:
    """Rough syllable count."""
    word = word.lower().strip(".,!?;:\"'")
    if not word:
        return 1
    count = 0
    vowels = "aeiouy"
    prev_vowel = False
    for char in word:
        is_vowel = char in vowels
        if is_vowel and not prev_vowel:
            count += 1
        prev_vowel = is_vowel
    if word.endswith("e") and count > 1:
        count -= 1
    return max(count, 1)


# ── FastAPI App ──

@asynccontextmanager
async def lifespan(app: FastAPI):
    await register_on_ghola()
    yield
    print("[merchant] Shutting down")

app = FastAPI(
    title="Text Analysis API",
    description="Headless merchant: text analysis at $0.002/request via Ghola",
    lifespan=lifespan,
)


@app.post("/analyze")
async def analyze(request: Request):
    body = await request.json()
    text = body.get("text", "")

    if not text:
        return JSONResponse({"error": "text field is required"}, status_code=400)

    result = analyze_text(text)

    # Meter this request through Ghola
    agent_did = request.headers.get("X-Agent-DID", "unknown")
    asyncio.create_task(meter_usage(agent_did))

    return result


@app.get("/health")
async def health():
    return {"status": "healthy", "service": "text-analyzer"}


@app.get("/pricing")
async def pricing():
    return {
        "service": "text-analyzer",
        "price_micro_usdc": 2000,
        "price_usdc": 0.002,
        "free_tier_per_day": 50,
        "currency": "USDC",
        "endpoints": [{
            "path": "/analyze",
            "method": "POST",
            "price_micro_usdc": 2000,
        }],
    }


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PORT)
