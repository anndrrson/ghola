from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional, Union


@dataclass
class BusinessLocation:
    address: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    country: Optional[str] = None
    postal_code: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None


@dataclass
class BusinessContact:
    email: Optional[str] = None
    phone: Optional[str] = None
    support_url: Optional[str] = None


@dataclass
class ServiceDefinition:
    name: str = ""
    description: str = ""
    price: Optional[str] = None
    availability: Optional[str] = None
    booking_url: Optional[str] = None
    api_endpoint: Optional[str] = None
    parameters: dict = field(default_factory=dict)


@dataclass
class ApiEndpoint:
    name: str = ""
    url: str = ""
    method: str = "GET"
    auth_type: str = "none"
    description: str = ""
    request_schema: dict = field(default_factory=dict)
    response_schema: dict = field(default_factory=dict)


@dataclass
class PolicyDefinition:
    name: str = ""
    content: str = ""
    machine_readable: dict = field(default_factory=dict)


@dataclass
class BusinessProfile:
    did: str = ""
    business_name: str = ""
    handle: Optional[str] = None
    category: str = ""
    description: str = ""
    logo_url: Optional[str] = None
    website: str = ""
    verified_domain: Optional[str] = None
    verified_at: Optional[str] = None
    operating_hours: Optional[dict] = None
    location: Optional[BusinessLocation] = None
    contact: Optional[BusinessContact] = None
    services: list[ServiceDefinition] = field(default_factory=list)
    policies: list[PolicyDefinition] = field(default_factory=list)
    api_endpoints: list[ApiEndpoint] = field(default_factory=list)
    payment_methods: list[str] = field(default_factory=list)
    created_at: str = ""
    updated_at: str = ""


@dataclass
class GeoHint:
    city: Optional[str] = None
    region: Optional[str] = None
    country: Optional[str] = None
    timezone: Optional[str] = None


@dataclass
class AgentPreferences:
    communication_style: Optional[str] = None
    response_format: Optional[str] = None
    expertise_areas: list[str] = field(default_factory=list)
    dietary_restrictions: list[str] = field(default_factory=list)
    accessibility_needs: list[str] = field(default_factory=list)
    location: Optional[GeoHint] = None
    custom: dict = field(default_factory=dict)


@dataclass
class PublicProfile:
    did: str = ""
    display_name: str = ""
    handle: Optional[str] = None
    avatar_url: Optional[str] = None
    bio: Optional[str] = None
    timezone: Optional[str] = None
    agent_preferences: AgentPreferences = field(default_factory=AgentPreferences)
    on_chain_registered: bool = False


@dataclass
class AgentsTxtService:
    name: str = ""
    url: str = ""


@dataclass
class AgentsTxtAuth:
    method: str = ""
    url: str = ""


@dataclass
class AgentsTxt:
    identity: Optional[str] = None
    profile_url: Optional[str] = None
    said_json: Optional[str] = None
    allow_agents: list[str] = field(default_factory=list)
    services: list[AgentsTxtService] = field(default_factory=list)
    auth: Optional[AgentsTxtAuth] = None


@dataclass
class WellKnownSaid:
    said_version: str = "1.0"
    did: str = ""
    profile_url: Optional[str] = None
    business: Optional[dict] = None
    services: list[ServiceDefinition] = field(default_factory=list)
    operating_hours: Optional[dict] = None
    verification: Optional[dict] = None


@dataclass
class ResolvedProfile:
    profile_type: str = ""  # "business" or "consumer"
    profile: Union[BusinessProfile, PublicProfile] = field(
        default_factory=BusinessProfile
    )


@dataclass
class DomainDiscovery:
    domain: str = ""
    agents_txt: Optional[AgentsTxt] = None
    well_known: Optional[WellKnownSaid] = None
