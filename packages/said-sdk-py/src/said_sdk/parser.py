"""Parsers for agents.txt and .well-known/said.json."""

from __future__ import annotations

import json
from typing import Optional

from .error import SAIDError
from .types import (
    AgentsTxt,
    AgentsTxtAuth,
    AgentsTxtService,
    AgentsTxtSkill,
    ServiceDefinition,
    WellKnownSaid,
)


def _parse_service_directive(value: str) -> Optional[AgentsTxtService]:
    """Parse a Service directive value: 'name url'."""
    parts = value.split(None, 1)
    if len(parts) < 2:
        return None
    return AgentsTxtService(name=parts[0], url=parts[1])


def _parse_skill_directive(value: str) -> Optional[AgentsTxtSkill]:
    """Parse a Skill directive value: 'name url'."""
    parts = value.split(None, 1)
    if len(parts) < 2:
        return None
    return AgentsTxtSkill(name=parts[0], url=parts[1])


def _parse_auth_directive(value: str) -> Optional[AgentsTxtAuth]:
    """Parse an Auth directive value: 'method url'."""
    parts = value.split(None, 1)
    if len(parts) < 2:
        return None
    return AgentsTxtAuth(method=parts[0], url=parts[1])


def parse_agents_txt(content: str) -> AgentsTxt:
    """Parse agents.txt content into structured data.

    Parsing rules:
    - Lines starting with # are comments
    - Empty lines are skipped
    - Directive format: Key: value (case-insensitive key)
    - Identity/Profile/Said-Json: last occurrence wins
    - Allow-Agent/Service: append all occurrences
    - Service format: "Service: name url"
    - Auth format: "Auth: method url"
    - Unknown directives: skip
    """
    result = AgentsTxt()

    for raw_line in content.split("\n"):
        line = raw_line.strip()

        # Skip empty lines and comments
        if not line or line.startswith("#"):
            continue

        # Parse directive: "Key: value"
        colon_idx = line.find(":")
        if colon_idx == -1:
            continue

        key = line[:colon_idx].strip().lower()
        value = line[colon_idx + 1 :].strip()

        if key == "identity":
            result.identity = value
        elif key == "profile":
            result.profile_url = value
        elif key == "said-json":
            result.said_json = value
        elif key == "allow-agent":
            if value:
                result.allow_agents.append(value)
        elif key == "service":
            service = _parse_service_directive(value)
            if service is not None:
                result.services.append(service)
        elif key == "skill":
            skill = _parse_skill_directive(value)
            if skill is not None:
                result.skills.append(skill)
        elif key == "auth":
            auth = _parse_auth_directive(value)
            if auth is not None:
                result.auth = auth
        # Unknown directives: skip

    return result


def parse_well_known_said(json_str: str) -> WellKnownSaid:
    """Parse .well-known/said.json content.

    Raises SAIDError if the JSON is invalid.
    """
    try:
        data = json.loads(json_str)
    except (json.JSONDecodeError, ValueError) as exc:
        raise SAIDError(
            "Invalid said.json: failed to parse JSON",
            code="PARSE_ERROR",
        ) from exc

    services: list[ServiceDefinition] = []
    for svc in data.get("services", []):
        if isinstance(svc, dict):
            services.append(
                ServiceDefinition(
                    name=svc.get("name", ""),
                    description=svc.get("description", ""),
                    price=svc.get("price"),
                    availability=svc.get("availability"),
                    booking_url=svc.get("booking_url"),
                    api_endpoint=svc.get("api_endpoint"),
                    parameters=svc.get("parameters", {}),
                )
            )

    return WellKnownSaid(
        said_version=data.get("said_version", "1.0"),
        did=data.get("did", ""),
        profile_url=data.get("profile_url"),
        business=data.get("business"),
        services=services,
        operating_hours=data.get("operating_hours"),
        verification=data.get("verification"),
    )
