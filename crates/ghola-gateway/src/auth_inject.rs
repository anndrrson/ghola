//! Inject the merchant's upstream credential into an outbound request.
//!
//! Called exactly once per proxied call, immediately before the request is
//! forwarded. The plaintext credential is held in a local `String` that
//! drops at the end of this function — it never touches the cache, the DB,
//! or any response path.

use reqwest::header::{HeaderName, HeaderValue, AUTHORIZATION};
use reqwest::RequestBuilder;

use said_turnkey::AuthMode;

/// Apply auth to an outbound request. `plaintext` is the decrypted credential.
/// `header_name_override` is only used when `mode == ApiKeyHeader`; for every
/// other mode it's ignored.
pub fn inject(
    mut req: RequestBuilder,
    mode: AuthMode,
    header_name_override: Option<&str>,
    plaintext: &str,
    url: &str,
) -> Result<(RequestBuilder, String), anyhow::Error> {
    // For query-mode we have to rewrite the URL. For header modes we attach
    // via reqwest's header API. Return the (possibly-rewritten) URL so the
    // caller can log it.
    match mode {
        AuthMode::None => Ok((req, url.to_string())),

        AuthMode::Bearer => {
            let val = format!("Bearer {plaintext}");
            let hv = HeaderValue::from_str(&val)
                .map_err(|e| anyhow::anyhow!("invalid bearer token: {e}"))?;
            req = req.header(AUTHORIZATION, hv);
            Ok((req, url.to_string()))
        }

        AuthMode::ApiKeyHeader => {
            let name = header_name_override
                .ok_or_else(|| anyhow::anyhow!("api_key_header mode requires a header name"))?;
            let hn = HeaderName::from_bytes(name.as_bytes())
                .map_err(|e| anyhow::anyhow!("invalid header name '{name}': {e}"))?;
            let hv = HeaderValue::from_str(plaintext)
                .map_err(|e| anyhow::anyhow!("invalid api key value: {e}"))?;
            req = req.header(hn, hv);
            Ok((req, url.to_string()))
        }

        AuthMode::ApiKeyQuery => {
            // Append ?api_key=... (or &api_key=...) depending on whether the
            // URL already has a query string. Use the `url` crate to handle
            // escaping correctly.
            let mut parsed = url::Url::parse(url)
                .map_err(|e| anyhow::anyhow!("cannot parse upstream URL: {e}"))?;
            parsed
                .query_pairs_mut()
                .append_pair("api_key", plaintext);
            Ok((req, parsed.to_string()))
        }

        AuthMode::Basic => {
            // `plaintext` is stored as "user:password" — base64-encode it.
            use base64::Engine;
            let b64 = base64::engine::general_purpose::STANDARD.encode(plaintext.as_bytes());
            let val = format!("Basic {b64}");
            let hv = HeaderValue::from_str(&val)
                .map_err(|e| anyhow::anyhow!("invalid basic auth: {e}"))?;
            req = req.header(AUTHORIZATION, hv);
            Ok((req, url.to_string()))
        }
    }
}
