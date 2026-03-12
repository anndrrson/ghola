# Integrating SAID with OpenAI Function Calling

Use SAID identities as OpenAI function definitions. Your GPT-powered agents get business discovery and service calling without building custom API integrations for every business.

## Install

```bash
pip install said-sdk openai
```

## Example 1: Define SAID Tools as OpenAI Functions

Map SAID operations to OpenAI's function calling schema.

```python
tools = [
    {
        "type": "function",
        "function": {
            "name": "resolve_business",
            "description": (
                "Look up a business's SAID identity by domain. Returns the "
                "business profile including services, operating hours, "
                "policies, and API endpoints."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "domain": {
                        "type": "string",
                        "description": "Business domain name (e.g. luigis-pizza.com)",
                    }
                },
                "required": ["domain"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "resolve_identity",
            "description": (
                "Resolve a SAID identity by DID (did:key:...) or @handle. "
                "Returns the public profile with preferences and contact info."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "did_or_handle": {
                        "type": "string",
                        "description": "DID (did:key:z6Mk...) or @handle",
                    }
                },
                "required": ["did_or_handle"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "call_service",
            "description": (
                "Call a business service endpoint discovered from its SAID "
                "profile. Use the URL from resolve_business results."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "Service API endpoint URL",
                    },
                    "method": {
                        "type": "string",
                        "enum": ["GET", "POST", "PUT", "DELETE"],
                        "description": "HTTP method (default: GET)",
                    },
                    "body": {
                        "type": "string",
                        "description": "JSON request body for POST/PUT requests",
                    },
                },
                "required": ["url"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_user_preferences",
            "description": (
                "Get the current user's SAID preferences. Use this to "
                "personalize responses (dietary restrictions, communication "
                "style, accessibility needs, etc)."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "did": {
                        "type": "string",
                        "description": "User's DID",
                    }
                },
                "required": ["did"],
            },
        },
    },
]
```

## Example 2: Handle Function Calls with the SAID SDK

Dispatch OpenAI function calls to the SAID SDK.

```python
import json
import httpx
from said_sdk import SAIDClient, SAIDError


async def handle_function_call(name: str, arguments: dict) -> str:
    """Route an OpenAI function call to the SAID SDK."""

    async with SAIDClient() as said:
        if name == "resolve_business":
            try:
                result = await said.resolve_by_domain(arguments["domain"])
                output = {"domain": result.domain}

                if result.agents_txt:
                    output["identity"] = result.agents_txt.identity
                    output["services"] = [
                        {"name": s.name, "url": s.url}
                        for s in result.agents_txt.services
                    ]

                if result.well_known:
                    output["business"] = result.well_known.business
                    output["operating_hours"] = result.well_known.operating_hours
                    output["service_details"] = [
                        {
                            "name": s.name,
                            "description": s.description,
                            "price": s.price,
                            "booking_url": s.booking_url,
                        }
                        for s in result.well_known.services
                    ]

                return json.dumps(output, indent=2)
            except SAIDError as e:
                if e.status == 404:
                    return json.dumps({"error": f"No SAID profile found for {arguments['domain']}"})
                raise

        elif name == "resolve_identity":
            result = await said.resolve(arguments["did_or_handle"])
            return json.dumps({
                "profile_type": result.profile_type,
                "profile": result.profile.__dict__,
            }, indent=2, default=str)

        elif name == "call_service":
            url = arguments["url"]
            method = arguments.get("method", "GET").upper()
            body = arguments.get("body", "")

            async with httpx.AsyncClient(timeout=15.0) as client:
                if method == "POST":
                    resp = await client.post(url, content=body, headers={
                        "Content-Type": "application/json",
                    })
                elif method == "PUT":
                    resp = await client.put(url, content=body, headers={
                        "Content-Type": "application/json",
                    })
                elif method == "DELETE":
                    resp = await client.delete(url)
                else:
                    resp = await client.get(url)

                return resp.text

        elif name == "get_user_preferences":
            profile = await said.get_public_profile(arguments["did"])
            prefs = profile.agent_preferences
            return json.dumps({
                "communication_style": prefs.communication_style,
                "response_format": prefs.response_format,
                "dietary_restrictions": prefs.dietary_restrictions,
                "accessibility_needs": prefs.accessibility_needs,
                "expertise_areas": prefs.expertise_areas,
                "location": prefs.location.__dict__ if prefs.location else None,
                "custom": prefs.custom,
            }, indent=2)

    return json.dumps({"error": f"Unknown function: {name}"})
```

## Example 3: Full Conversation Loop

Complete agentic loop with business discovery and service calling.

```python
import asyncio
import json
from openai import AsyncOpenAI

client = AsyncOpenAI()


async def run_agent(user_message: str, user_did: str | None = None):
    messages = [
        {
            "role": "system",
            "content": (
                "You are a helpful assistant that can discover businesses and "
                "book services using the SAID identity network. Always look up "
                "the business profile before calling service endpoints. If a "
                "user DID is provided, check their preferences first."
            ),
        },
        {"role": "user", "content": user_message},
    ]

    # If we know the user, prepend a preference lookup
    if user_did:
        messages[0]["content"] += (
            f"\n\nThe current user's DID is {user_did}. "
            "Check their preferences at the start of the conversation."
        )

    max_iterations = 10

    for _ in range(max_iterations):
        response = await client.chat.completions.create(
            model="gpt-4o",
            messages=messages,
            tools=tools,
            tool_choice="auto",
        )

        choice = response.choices[0]

        # If the model is done, return the final message
        if choice.finish_reason == "stop":
            return choice.message.content

        # Process tool calls
        if choice.message.tool_calls:
            messages.append(choice.message)

            for tool_call in choice.message.tool_calls:
                fn_name = tool_call.function.name
                fn_args = json.loads(tool_call.function.arguments)

                result = await handle_function_call(fn_name, fn_args)

                messages.append({
                    "role": "tool",
                    "tool_call_id": tool_call.id,
                    "content": result,
                })
        else:
            # No tool calls and not stopped -- shouldn't happen, but bail
            return choice.message.content

    return "Reached maximum iterations without completing the task."


# Run it
async def main():
    result = await run_agent(
        "Book a table for 2 at luigis-pizza.com tonight at 7pm. "
        "I'm vegetarian.",
        user_did="did:key:z6MkUser123...",
    )
    print(result)

asyncio.run(main())
```

## Tips

**Streaming**: Use `stream=True` and handle tool calls from streamed chunks. Function calls arrive as deltas that you concatenate.

```python
async def run_agent_streaming(user_message: str):
    messages = [
        {"role": "system", "content": "You are a SAID-enabled assistant."},
        {"role": "user", "content": user_message},
    ]

    while True:
        stream = await client.chat.completions.create(
            model="gpt-4o",
            messages=messages,
            tools=tools,
            stream=True,
        )

        collected_tool_calls = {}
        content_parts = []

        async for chunk in stream:
            delta = chunk.choices[0].delta

            if delta.content:
                content_parts.append(delta.content)
                print(delta.content, end="", flush=True)

            if delta.tool_calls:
                for tc in delta.tool_calls:
                    idx = tc.index
                    if idx not in collected_tool_calls:
                        collected_tool_calls[idx] = {
                            "id": tc.id, "name": "", "arguments": ""
                        }
                    if tc.id:
                        collected_tool_calls[idx]["id"] = tc.id
                    if tc.function and tc.function.name:
                        collected_tool_calls[idx]["name"] = tc.function.name
                    if tc.function and tc.function.arguments:
                        collected_tool_calls[idx]["arguments"] += tc.function.arguments

        if not collected_tool_calls:
            break

        # Execute tool calls
        for tc in collected_tool_calls.values():
            args = json.loads(tc["arguments"])
            result = await handle_function_call(tc["name"], args)
            messages.append({
                "role": "tool",
                "tool_call_id": tc["id"],
                "content": result,
            })
```

**Structured outputs**: Use `response_format` with a Pydantic model for predictable booking confirmations.

```python
from pydantic import BaseModel

class BookingResult(BaseModel):
    business_name: str
    service: str
    date: str
    time: str
    party_size: int
    confirmation_id: str | None
    notes: str
```

**Error handling**: Always return errors as tool results, not exceptions. The model can recover.

```python
async def handle_function_call(name: str, arguments: dict) -> str:
    try:
        return await _dispatch(name, arguments)
    except SAIDError as e:
        return json.dumps({
            "error": str(e),
            "suggestion": "Try a different domain or check spelling.",
        })
    except httpx.TimeoutException:
        return json.dumps({
            "error": "Service endpoint timed out",
            "suggestion": "The business API may be down. Inform the user.",
        })
```

**Cost optimization**: Cache SAID profile lookups. A resolve call costs one HTTP request; don't repeat it in the same conversation.

```python
_resolved: dict[str, str] = {}

async def handle_function_call(name: str, arguments: dict) -> str:
    if name == "resolve_business":
        domain = arguments["domain"]
        if domain in _resolved:
            return _resolved[domain]
        result = await _do_resolve(domain)
        _resolved[domain] = result
        return result
    # ...
```
