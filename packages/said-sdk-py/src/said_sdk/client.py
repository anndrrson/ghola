"""SAID SDK client for resolving identities and discovering businesses."""

from __future__ import annotations

from typing import Any, Optional

import httpx

from .error import SAIDError
from .parser import parse_agents_txt, parse_well_known_said
from .types import (
    AgentPreferences,
    AgentsTxt,
    ApiEndpoint,
    BusinessContact,
    BusinessLocation,
    BusinessProfile,
    DomainDiscovery,
    GeoHint,
    PolicyDefinition,
    PublicProfile,
    ResolvedProfile,
    ServiceDefinition,
    WellKnownSaid,
)


def _parse_business_profile(data: dict[str, Any]) -> BusinessProfile:
    """Deserialize a dict into a BusinessProfile."""
    location = None
    if data.get("location"):
        loc = data["location"]
        location = BusinessLocation(
            address=loc.get("address"),
            city=loc.get("city"),
            state=loc.get("state"),
            country=loc.get("country"),
            postal_code=loc.get("postal_code"),
            latitude=loc.get("latitude"),
            longitude=loc.get("longitude"),
        )

    contact = None
    if data.get("contact"):
        c = data["contact"]
        contact = BusinessContact(
            email=c.get("email"),
            phone=c.get("phone"),
            support_url=c.get("support_url"),
        )

    services = [
        ServiceDefinition(
            name=s.get("name", ""),
            description=s.get("description", ""),
            price=s.get("price"),
            availability=s.get("availability"),
            booking_url=s.get("booking_url"),
            api_endpoint=s.get("api_endpoint"),
            parameters=s.get("parameters", {}),
        )
        for s in data.get("services", [])
    ]

    policies = [
        PolicyDefinition(
            name=p.get("name", ""),
            content=p.get("content", ""),
            machine_readable=p.get("machine_readable", {}),
        )
        for p in data.get("policies", [])
    ]

    api_endpoints = [
        ApiEndpoint(
            name=e.get("name", ""),
            url=e.get("url", ""),
            method=e.get("method", "GET"),
            auth_type=e.get("auth_type", "none"),
            description=e.get("description", ""),
            request_schema=e.get("request_schema", {}),
            response_schema=e.get("response_schema", {}),
        )
        for e in data.get("api_endpoints", [])
    ]

    return BusinessProfile(
        did=data.get("did", ""),
        business_name=data.get("business_name", ""),
        handle=data.get("handle"),
        category=data.get("category", ""),
        description=data.get("description", ""),
        logo_url=data.get("logo_url"),
        website=data.get("website", ""),
        verified_domain=data.get("verified_domain"),
        verified_at=data.get("verified_at"),
        operating_hours=data.get("operating_hours"),
        location=location,
        contact=contact,
        services=services,
        policies=policies,
        api_endpoints=api_endpoints,
        payment_methods=data.get("payment_methods", []),
        created_at=data.get("created_at", ""),
        updated_at=data.get("updated_at", ""),
    )


def _parse_public_profile(data: dict[str, Any]) -> PublicProfile:
    """Deserialize a dict into a PublicProfile."""
    prefs_data = data.get("agent_preferences", {})
    geo = None
    if prefs_data.get("location"):
        g = prefs_data["location"]
        geo = GeoHint(
            city=g.get("city"),
            region=g.get("region"),
            country=g.get("country"),
            timezone=g.get("timezone"),
        )

    prefs = AgentPreferences(
        communication_style=prefs_data.get("communication_style"),
        response_format=prefs_data.get("response_format"),
        expertise_areas=prefs_data.get("expertise_areas", []),
        dietary_restrictions=prefs_data.get("dietary_restrictions", []),
        accessibility_needs=prefs_data.get("accessibility_needs", []),
        location=geo,
        custom=prefs_data.get("custom", {}),
    )

    return PublicProfile(
        did=data.get("did", ""),
        display_name=data.get("display_name", ""),
        handle=data.get("handle"),
        avatar_url=data.get("avatar_url"),
        bio=data.get("bio"),
        timezone=data.get("timezone"),
        agent_preferences=prefs,
        on_chain_registered=data.get("on_chain_registered", False),
    )


class SAIDClient:
    """Async client for the SAID Identity API.

    Usage::

        async with SAIDClient(api_key="sk_...") as said:
            profile = await said.resolve("did:key:z6Mk...")
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: str = "https://api.said.id/v1",
        timeout: float = 10.0,
    ):
        self._base_url = base_url
        self._timeout = timeout
        headers: dict[str, str] = {}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        self._client = httpx.AsyncClient(
            base_url=base_url,
            timeout=timeout,
            headers=headers,
        )

    # -- API methods ----------------------------------------------------------

    async def resolve(self, did_or_handle: str) -> ResolvedProfile:
        """Resolve an identity by DID or @handle."""
        resp = await self._client.get(f"/resolve/{did_or_handle}")
        self._raise_for_status(resp)
        data = resp.json()

        profile_type = data.get("profile_type", "")
        if profile_type == "business":
            profile = _parse_business_profile(data.get("profile", {}))
        else:
            profile = _parse_public_profile(data.get("profile", {}))

        return ResolvedProfile(profile_type=profile_type, profile=profile)

    async def resolve_by_domain(self, domain: str) -> DomainDiscovery:
        """Resolve a business by its domain."""
        resp = await self._client.get("/discover", params={"domain": domain})
        self._raise_for_status(resp)
        data = resp.json()

        agents_txt = None
        if data.get("agents_txt"):
            at = data["agents_txt"]
            agents_txt = AgentsTxt(
                identity=at.get("identity"),
                profile_url=at.get("profile_url"),
                said_json=at.get("said_json"),
                allow_agents=at.get("allow_agents", []),
                services=[],
                auth=None,
            )

        well_known = None
        if data.get("well_known"):
            wk = data["well_known"]
            well_known = WellKnownSaid(
                said_version=wk.get("said_version", "1.0"),
                did=wk.get("did", ""),
                profile_url=wk.get("profile_url"),
                business=wk.get("business"),
                services=[],
                operating_hours=wk.get("operating_hours"),
                verification=wk.get("verification"),
            )

        return DomainDiscovery(
            domain=data.get("domain", domain),
            agents_txt=agents_txt,
            well_known=well_known,
        )

    async def fetch_agents_txt(self, domain: str) -> AgentsTxt:
        """Fetch and parse agents.txt from a domain."""
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"https://{domain}/agents.txt", timeout=self._timeout
            )
            self._raise_for_status(resp)
            return parse_agents_txt(resp.text)

    async def fetch_well_known_said(self, domain: str) -> WellKnownSaid:
        """Fetch and parse .well-known/said.json from a domain."""
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"https://{domain}/.well-known/said.json", timeout=self._timeout
            )
            self._raise_for_status(resp)
            return parse_well_known_said(resp.text)

    async def get_public_profile(self, did: str) -> PublicProfile:
        """Get a public consumer profile by DID."""
        resp = await self._client.get(f"/profile/{did}")
        self._raise_for_status(resp)
        return _parse_public_profile(resp.json())

    # -- Lifecycle ------------------------------------------------------------

    async def close(self) -> None:
        """Close the underlying HTTP client."""
        await self._client.aclose()

    async def __aenter__(self) -> "SAIDClient":
        return self

    async def __aexit__(self, *args: object) -> None:
        await self.close()

    # -- Helpers --------------------------------------------------------------

    @staticmethod
    def _raise_for_status(resp: httpx.Response) -> None:
        """Translate HTTP errors into SAIDError."""
        if resp.is_success:
            return
        try:
            body = resp.json()
            message = body.get("error", resp.reason_phrase or "Unknown error")
            code = body.get("code")
        except Exception:
            message = resp.reason_phrase or "Unknown error"
            code = None
        raise SAIDError(message, status=resp.status_code, code=code)
