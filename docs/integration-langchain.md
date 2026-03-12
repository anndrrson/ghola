# Integrating SAID with LangChain

Build LangChain agents that know who they're talking to. SAID gives your agents portable identity resolution, business discovery, and service calling -- so they can find a restaurant, read its policies, and make a reservation without hardcoded API integrations.

## Install

```bash
pip install said-sdk langchain langchain-openai
```

## Example 1: Identity Resolution Tool

A custom LangChain tool that resolves SAID identities by DID, @handle, or domain name.

```python
import json
from langchain.tools import BaseTool
from said_sdk import SAIDClient


class SAIDResolveTool(BaseTool):
    name: str = "said_resolve"
    description: str = (
        "Resolve a SAID identity by DID, @handle, or domain name. "
        "Returns the business profile including services, hours, policies, "
        "and API endpoints. Use this to look up any business or person."
    )

    async def _arun(self, query: str) -> str:
        async with SAIDClient() as said:
            if "." in query and not query.startswith("did:"):
                result = await said.resolve_by_domain(query)
                return json.dumps({
                    "domain": result.domain,
                    "agents_txt": {
                        "identity": result.agents_txt.identity,
                        "services": [
                            {"name": s.name, "url": s.url}
                            for s in (result.agents_txt.services if result.agents_txt else [])
                        ],
                    } if result.agents_txt else None,
                }, indent=2)
            else:
                result = await said.resolve(query)
                return json.dumps({
                    "profile_type": result.profile_type,
                    "profile": result.profile.__dict__,
                }, indent=2, default=str)

    def _run(self, query: str) -> str:
        import asyncio
        return asyncio.run(self._arun(query))
```

## Example 2: Business Discovery + Booking Agent

A LangChain agent that discovers businesses and books services through their SAID profiles.

```python
import json
from langchain.tools import BaseTool
from langchain_openai import ChatOpenAI
from langchain.agents import AgentExecutor, create_openai_tools_agent
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from said_sdk import SAIDClient


class DiscoverBusinessTool(BaseTool):
    name: str = "discover_business"
    description: str = (
        "Discover a business by domain. Returns its SAID profile with "
        "services, operating hours, policies, and booking endpoints."
    )

    async def _arun(self, domain: str) -> str:
        async with SAIDClient() as said:
            discovery = await said.resolve_by_domain(domain)
            if discovery.well_known and discovery.well_known.business:
                return json.dumps(discovery.well_known.business, indent=2)
            if discovery.agents_txt:
                return json.dumps({
                    "identity": discovery.agents_txt.identity,
                    "services": [
                        {"name": s.name, "url": s.url}
                        for s in discovery.agents_txt.services
                    ],
                }, indent=2)
            return "No SAID profile found for this domain."

    def _run(self, domain: str) -> str:
        import asyncio
        return asyncio.run(self._arun(domain))


class CallServiceTool(BaseTool):
    name: str = "call_service"
    description: str = (
        "Call a business service endpoint. Provide the URL from the business "
        "profile and an optional JSON body for POST requests."
    )

    async def _arun(self, url: str, method: str = "GET", body: str = "") -> str:
        import httpx
        async with httpx.AsyncClient(timeout=15.0) as client:
            if method.upper() == "POST":
                resp = await client.post(url, content=body, headers={
                    "Content-Type": "application/json"
                })
            else:
                resp = await client.get(url)
            return resp.text

    def _run(self, url: str, method: str = "GET", body: str = "") -> str:
        import asyncio
        return asyncio.run(self._arun(url, method, body))


# Build the agent
llm = ChatOpenAI(model="gpt-4o", temperature=0)
tools = [DiscoverBusinessTool(), CallServiceTool(), SAIDResolveTool()]

prompt = ChatPromptTemplate.from_messages([
    ("system",
     "You are a helpful assistant that can discover businesses and book "
     "services using the SAID identity network. Always discover a business "
     "profile first before attempting to call its service endpoints."),
    MessagesPlaceholder("chat_history", optional=True),
    ("human", "{input}"),
    MessagesPlaceholder("agent_scratchpad"),
])

agent = create_openai_tools_agent(llm, tools, prompt)
executor = AgentExecutor(agent=agent, tools=tools, verbose=True)

# Run it
result = executor.invoke({
    "input": "Find the restaurant at luigis-pizza.com and book a table for 2 at 7pm tonight"
})
print(result["output"])
```

## Example 3: agents.txt as a LangChain Retriever

Use agents.txt files as a document source for RAG pipelines.

```python
from langchain_core.documents import Document
from langchain_core.retrievers import BaseRetriever
from said_sdk import SAIDClient, parse_agents_txt
from pydantic import Field


class AgentsTxtRetriever(BaseRetriever):
    """Retriever that fetches business info from agents.txt files."""

    domains: list[str] = Field(default_factory=list)

    async def _aget_relevant_documents(self, query: str) -> list[Document]:
        docs = []
        async with SAIDClient() as said:
            for domain in self.domains:
                try:
                    agents = await said.fetch_agents_txt(domain)
                    well_known = await said.fetch_well_known_said(domain)

                    content = f"Business: {domain}\n"
                    if agents.identity:
                        content += f"DID: {agents.identity}\n"
                    for svc in agents.services:
                        content += f"Service: {svc.name} -> {svc.url}\n"
                    if well_known.business:
                        content += f"Details: {well_known.business}\n"

                    docs.append(Document(
                        page_content=content,
                        metadata={"domain": domain, "did": agents.identity or ""},
                    ))
                except Exception:
                    continue
        return docs

    def _get_relevant_documents(self, query: str) -> list[Document]:
        import asyncio
        return asyncio.run(self._aget_relevant_documents(query))


# Usage
retriever = AgentsTxtRetriever(domains=[
    "luigis-pizza.com",
    "joes-barbershop.com",
    "downtown-gym.com",
])
docs = retriever.invoke("pizza restaurant with delivery")
```

## Tips

**Caching**: SAID profiles don't change frequently. Cache resolved profiles for 5-15 minutes.

```python
from functools import lru_cache
import time

_cache: dict[str, tuple[float, object]] = {}

async def cached_resolve(said: SAIDClient, domain: str, ttl: float = 300.0):
    now = time.time()
    if domain in _cache and now - _cache[domain][0] < ttl:
        return _cache[domain][1]
    result = await said.resolve_by_domain(domain)
    _cache[domain] = (now, result)
    return result
```

**Error handling**: Always handle the case where a domain has no SAID profile.

```python
from said_sdk import SAIDError

try:
    result = await said.resolve_by_domain("example.com")
except SAIDError as e:
    if e.status == 404:
        # Domain has no SAID profile -- fall back to web search
        pass
    else:
        raise
```

**Combine with user identity**: If your user has a SAID wallet, load their preferences to personalize agent behavior.

```python
async with SAIDClient(api_key="sk_...") as said:
    user = await said.get_public_profile("did:key:z6MkUser...")
    prefs = user.agent_preferences

    system_msg = f"User prefers {prefs.communication_style} responses."
    if prefs.dietary_restrictions:
        system_msg += f" Dietary restrictions: {', '.join(prefs.dietary_restrictions)}."
```
