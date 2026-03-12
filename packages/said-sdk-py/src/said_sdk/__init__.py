"""SAID Identity SDK -- Resolve identities and discover agent-friendly businesses."""

from .client import SAIDClient
from .error import SAIDError
from .parser import parse_agents_txt, parse_well_known_said
from .types import (
    AgentPreferences,
    AgentsTxt,
    AgentsTxtAuth,
    AgentsTxtService,
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

__all__ = [
    "SAIDClient",
    "SAIDError",
    "parse_agents_txt",
    "parse_well_known_said",
    "AgentPreferences",
    "AgentsTxt",
    "AgentsTxtAuth",
    "AgentsTxtService",
    "ApiEndpoint",
    "BusinessContact",
    "BusinessLocation",
    "BusinessProfile",
    "DomainDiscovery",
    "GeoHint",
    "PolicyDefinition",
    "PublicProfile",
    "ResolvedProfile",
    "ServiceDefinition",
    "WellKnownSaid",
]
