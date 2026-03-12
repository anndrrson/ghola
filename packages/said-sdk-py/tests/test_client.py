from said_sdk import SAIDClient


def test_client_defaults():
    client = SAIDClient()
    assert client._base_url == "https://api.said.id/v1"
    assert client._timeout == 10.0


def test_client_custom_options():
    client = SAIDClient(api_key="sk_test", base_url="http://localhost:8080/v1")
    assert client._base_url == "http://localhost:8080/v1"


def test_client_auth_header():
    client = SAIDClient(api_key="sk_test")
    assert client._client.headers["authorization"] == "Bearer sk_test"


def test_client_no_auth_header():
    client = SAIDClient()
    assert "authorization" not in client._client.headers
