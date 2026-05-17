# Integrating SAID with CrewAI

Build CrewAI agents that discover businesses, read their policies, and take actions on your behalf. SAID turns the open web into an agent-addressable service layer -- every business with an `agents.txt` file becomes a tool your crew can interact with.

## Install

```bash
pip install said-sdk crewai crewai-tools
```

## Example 1: Business Discovery Tool

A CrewAI tool that looks up a business's SAID profile by domain.

```python
import asyncio
import json
from crewai_tools import BaseTool
from said_sdk import SAIDClient


class BusinessDiscoveryTool(BaseTool):
    name: str = "discover_business"
    description: str = (
        "Discover a business's SAID profile and available services by domain. "
        "Returns identity, services, operating hours, and policies."
    )

    def _run(self, domain: str) -> str:
        async def _discover():
            async with SAIDClient() as said:
                result = await said.resolve_by_domain(domain)
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
                    if result.well_known.services:
                        output["service_details"] = [
                            {
                                "name": s.name,
                                "description": s.description,
                                "price": s.price,
                                "availability": s.availability,
                                "booking_url": s.booking_url,
                            }
                            for s in result.well_known.services
                        ]

                return json.dumps(output, indent=2)

        return asyncio.run(_discover())


class IdentityResolveTool(BaseTool):
    name: str = "resolve_identity"
    description: str = (
        "Resolve a SAID identity by DID (did:key:...) or @handle. "
        "Returns the full profile including contact info and preferences."
    )

    def _run(self, did_or_handle: str) -> str:
        async def _resolve():
            async with SAIDClient() as said:
                result = await said.resolve(did_or_handle)
                return json.dumps({
                    "profile_type": result.profile_type,
                    "profile": result.profile.__dict__,
                }, indent=2, default=str)

        return asyncio.run(_resolve())


class ServiceCallTool(BaseTool):
    name: str = "call_service"
    description: str = (
        "Call a business service API endpoint. Requires the URL from the "
        "business profile. Optionally provide method (GET/POST) and JSON body."
    )

    def _run(self, url: str, method: str = "GET", body: str = "") -> str:
        import httpx

        with httpx.Client(timeout=15.0) as client:
            if method.upper() == "POST":
                resp = client.post(url, content=body, headers={
                    "Content-Type": "application/json",
                })
            else:
                resp = client.get(url)
            return resp.text
```

## Example 2: Multi-Agent Crew (Research + Book)

A crew with two agents: a researcher that discovers businesses and a booker that makes reservations.

```python
from crewai import Agent, Task, Crew, Process

# Tools
discover = BusinessDiscoveryTool()
resolve = IdentityResolveTool()
call_svc = ServiceCallTool()

# Agents
researcher = Agent(
    role="Business Researcher",
    goal="Find businesses that match user requests by discovering their SAID profiles",
    backstory=(
        "You are an expert at finding businesses on the SAID identity network. "
        "You discover their profiles, services, hours, and policies so the "
        "booking agent has everything needed to take action."
    ),
    tools=[discover, resolve],
    verbose=True,
)

booker = Agent(
    role="Booking Agent",
    goal="Make reservations and bookings using business service endpoints",
    backstory=(
        "You handle the actual booking process. You receive business profiles "
        "from the researcher, check availability against operating hours and "
        "policies, then call the service endpoint to complete the booking."
    ),
    tools=[call_svc],
    verbose=True,
)

# Tasks
research_task = Task(
    description=(
        "Find a {business_type} at {domain}. Discover its SAID profile, "
        "list available services, operating hours, and any relevant policies "
        "(cancellation, deposits, etc)."
    ),
    expected_output=(
        "A summary of the business: name, services with URLs, "
        "operating hours, and policies that affect booking."
    ),
    agent=researcher,
)

booking_task = Task(
    description=(
        "Using the business profile from the researcher, book {service_request}. "
        "Check that the requested time is within operating hours. "
        "If the business has a cancellation policy, include it in the confirmation."
    ),
    expected_output=(
        "Booking confirmation with: business name, service booked, "
        "date/time, and any policy notes."
    ),
    agent=booker,
)

# Crew
crew = Crew(
    agents=[researcher, booker],
    tasks=[research_task, booking_task],
    process=Process.sequential,
    verbose=True,
)

# Run
result = crew.kickoff(inputs={
    "business_type": "restaurant",
    "domain": "luigis-pizza.com",
    "service_request": "table for 4 at 7:30pm this Friday",
})
print(result)
```

## Example 3: Policy-Driven Decision Making

Use SAID business policies to automate decisions in your crew without human intervention.

```python
import json
from crewai_tools import BaseTool
from said_sdk import SAIDClient


class PolicyCheckerTool(BaseTool):
    name: str = "check_policies"
    description: str = (
        "Check a business's SAID policies to determine what is allowed. "
        "Provide the domain and the action you want to take."
    )

    def _run(self, domain: str) -> str:
        import asyncio

        async def _check():
            async with SAIDClient() as said:
                resolved = await said.resolve_by_domain(domain)
                if not resolved.well_known:
                    return "No structured policies found."

                # Fetch the full profile for policies
                did = resolved.well_known.did
                if did:
                    profile = await said.resolve(did)
                    if profile.profile_type == "business":
                        policies = profile.profile.policies
                        return json.dumps([
                            {
                                "name": p.name,
                                "content": p.content,
                                "machine_readable": p.machine_readable,
                            }
                            for p in policies
                        ], indent=2)
                return "No policies published."

        return asyncio.run(_check())


# Agent that makes autonomous decisions based on policies
decision_agent = Agent(
    role="Policy Compliance Agent",
    goal="Determine whether a requested action complies with business policies",
    backstory=(
        "You read business policies from SAID profiles and determine whether "
        "a requested action is allowed. You check cancellation windows, "
        "deposit requirements, age restrictions, dress codes, etc. "
        "If a policy has machine_readable rules, use those for precise checks."
    ),
    tools=[PolicyCheckerTool(), BusinessDiscoveryTool()],
    verbose=True,
)

# Example: check if late cancellation is possible
compliance_task = Task(
    description=(
        "Check the policies at {domain} and determine: "
        "1. Can we cancel a reservation made for tonight? "
        "2. Will there be a fee? "
        "3. What is the cancellation window?"
    ),
    expected_output="Clear yes/no with policy details and any fees.",
    agent=decision_agent,
)
```

## Tips

**Async in CrewAI**: CrewAI tools use synchronous `_run`. Wrap async SAID SDK calls with `asyncio.run()` as shown above. If your application already has a running event loop, use `asyncio.get_event_loop().run_until_complete()` instead.

**Caching across tools**: Share a cache between tools so the discovery tool and the policy checker don't fetch the same profile twice.

```python
from said_sdk import SAIDClient

_profile_cache: dict[str, object] = {}

async def get_or_fetch(domain: str) -> object:
    if domain not in _profile_cache:
        async with SAIDClient() as said:
            _profile_cache[domain] = await said.resolve_by_domain(domain)
    return _profile_cache[domain]
```

**Error handling**: Businesses without SAID profiles will return 404. Handle gracefully.

```python
from said_sdk import SAIDError

def _run(self, domain: str) -> str:
    try:
        return asyncio.run(self._discover(domain))
    except SAIDError as e:
        if e.status == 404:
            return f"No SAID profile found for {domain}. This business has not adopted SAID yet."
        return f"Error resolving {domain}: {e}"
```

**Rate limiting**: When discovering multiple businesses in a crew, add a small delay between requests to be respectful of rate limits.

```python
import asyncio

async def batch_discover(domains: list[str]) -> list:
    results = []
    async with SAIDClient() as said:
        for domain in domains:
            try:
                result = await said.resolve_by_domain(domain)
                results.append(result)
            except SAIDError:
                continue
            await asyncio.sleep(0.5)  # be polite
    return results
```
