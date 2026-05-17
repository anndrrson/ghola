import json

import pytest

from said_sdk import parse_agents_txt, parse_well_known_said
from said_sdk.error import SAIDError


def test_parse_complete_agents_txt():
    content = """# agents.txt - SAID Protocol v1.0
Identity: did:key:z6MkTest123
Profile: https://api.said.id/v1/profile/did:key:z6MkTest123
Said-Json: /.well-known/said.json
Allow-Agent: *
Service: booking https://example.com/reserve
Service: menu https://example.com/menu
Auth: ucan https://example.com/.well-known/said-ucan"""
    result = parse_agents_txt(content)
    assert result.identity == "did:key:z6MkTest123"
    assert result.profile_url == "https://api.said.id/v1/profile/did:key:z6MkTest123"
    assert result.said_json == "/.well-known/said.json"
    assert result.allow_agents == ["*"]
    assert len(result.services) == 2
    assert result.services[0].name == "booking"
    assert result.services[0].url == "https://example.com/reserve"
    assert result.services[1].name == "menu"
    assert result.services[1].url == "https://example.com/menu"
    assert result.auth is not None
    assert result.auth.method == "ucan"
    assert result.auth.url == "https://example.com/.well-known/said-ucan"


def test_parse_minimal():
    result = parse_agents_txt("Identity: did:key:z6MkMinimal")
    assert result.identity == "did:key:z6MkMinimal"
    assert result.services == []
    assert result.auth is None
    assert result.allow_agents == []


def test_parse_comments_and_blanks():
    content = "# comment\n\nIdentity: did:key:z6MkTest\n# another comment\n"
    result = parse_agents_txt(content)
    assert result.identity == "did:key:z6MkTest"


def test_duplicate_identity_last_wins():
    content = "Identity: first\nIdentity: second"
    result = parse_agents_txt(content)
    assert result.identity == "second"


def test_parse_well_known_said():
    data = {"said_version": "1.0", "did": "did:key:z6MkTest", "services": []}
    result = parse_well_known_said(json.dumps(data))
    assert result.did == "did:key:z6MkTest"
    assert result.said_version == "1.0"
    assert result.services == []


def test_parse_well_known_said_with_services():
    data = {
        "said_version": "1.0",
        "did": "did:key:z6MkTest",
        "services": [
            {"name": "booking", "description": "Reserve a table", "price": "$0"}
        ],
    }
    result = parse_well_known_said(json.dumps(data))
    assert len(result.services) == 1
    assert result.services[0].name == "booking"
    assert result.services[0].description == "Reserve a table"
    assert result.services[0].price == "$0"


def test_invalid_json_raises():
    with pytest.raises(SAIDError, match="Invalid said.json"):
        parse_well_known_said("not json")


def test_multiple_allow_agents():
    content = "Identity: did:key:z6Mk\nAllow-Agent: agent1\nAllow-Agent: agent2"
    result = parse_agents_txt(content)
    assert result.allow_agents == ["agent1", "agent2"]


def test_case_insensitive_keys():
    content = "IDENTITY: did:key:z6Mk\nPROFILE: https://example.com"
    result = parse_agents_txt(content)
    assert result.identity == "did:key:z6Mk"
    assert result.profile_url == "https://example.com"


def test_unknown_directives_skipped():
    content = "Identity: did:key:z6Mk\nFoo: bar\nBaz: qux"
    result = parse_agents_txt(content)
    assert result.identity == "did:key:z6Mk"
    assert result.services == []


def test_malformed_service_single_word():
    content = "Service: onlyname"
    result = parse_agents_txt(content)
    assert result.services == []


def test_empty_content():
    result = parse_agents_txt("")
    assert result.identity is None
    assert result.services == []


def test_line_without_colon_skipped():
    content = "Identity: did:key:z6Mk\nno colon here\nProfile: https://x.com"
    result = parse_agents_txt(content)
    assert result.identity == "did:key:z6Mk"
    assert result.profile_url == "https://x.com"
