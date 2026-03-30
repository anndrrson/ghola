use axum::extract::FromRequestParts;
use axum::http::request::Parts;

use crate::error::HomeError;
use crate::state::HomeState;

/// Extractor that validates a Bearer token against paired devices.
pub struct PairedDevice(pub crate::state::PairedDevice);

impl FromRequestParts<HomeState> for PairedDevice {
    type Rejection = HomeError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &HomeState,
    ) -> Result<Self, Self::Rejection> {
        let auth_header = parts
            .headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .ok_or(HomeError::Unauthorized)?;

        let token = auth_header
            .strip_prefix("Bearer ")
            .ok_or(HomeError::Unauthorized)?;

        let device = state
            .paired_devices
            .get(token)
            .map(|d| d.value().clone())
            .ok_or(HomeError::Unauthorized)?;

        Ok(PairedDevice(device))
    }
}
