import contractJson from "./venue-execution-credential-contract.json";

export type VenueCredentialProvisioningMode =
  | "turnkey_delegated"
  | "programmatic_generated"
  | "manual_sealed_import";

export type VenueCredentialSecretHandling =
  | "turnkey_non_exportable"
  | "direct_to_attested_runtime"
  | "raw_exportable"
  | "plaintext_persisted"
  | "unknown";

export type TurnkeyAuthorizationRole = "venue_owner" | "delegated_agent" | "none";
export type VenueOwnerAuthorizationSource =
  | "turnkey_venue_owner"
  | "external_owner_signature"
  | "none";

export interface VenueExecutionPermissionAttestation {
  can_read: boolean;
  can_trade: boolean;
  can_withdraw: boolean;
  can_transfer: boolean;
  can_manage_credentials: boolean;
  can_export_secret: boolean;
  unknown_scopes?: string[];
}

export interface VenueExecutionCredentialRequest {
  venue_id: string;
  provisioning_mode: VenueCredentialProvisioningMode;
  turnkey_role: TurnkeyAuthorizationRole;
  owner_authorization_source: VenueOwnerAuthorizationSource;
  explicit_owner_authorization: boolean;
  owner_binding_verified: boolean;
  secret_handling: VenueCredentialSecretHandling;
  permission_attestation?: VenueExecutionPermissionAttestation | null;
  silent_provisioning?: boolean;
}

export type VenueExecutionCredentialBlockReason =
  | "venue_not_supported"
  | "provisioning_mode_not_supported"
  | "provisioning_mode_not_implemented"
  | "silent_provisioning_blocked"
  | "explicit_owner_authorization_required"
  | "owner_authorization_source_not_supported"
  | "turnkey_must_be_venue_owner"
  | "owner_binding_required"
  | "programmatic_secret_handling_not_supported"
  | "direct_seal_to_attested_runtime_required"
  | "permission_attestation_required"
  | "read_trade_permissions_required"
  | "withdrawal_permission_blocked"
  | "transfer_permission_blocked"
  | "credential_admin_permission_blocked"
  | "secret_export_permission_blocked"
  | "unknown_permission_scope_blocked";

export type VenueExecutionCredentialDecision =
  | {
      allowed: true;
      disposition: "provision" | "sealed_import";
      venue_id: string;
      provisioning_mode: VenueCredentialProvisioningMode;
    }
  | {
      allowed: false;
      disposition: "blocked";
      venue_id: string;
      provisioning_mode: VenueCredentialProvisioningMode;
      reason_codes: VenueExecutionCredentialBlockReason[];
    };

type VenueCredentialContractEntry = {
  provisioning_modes: VenueCredentialProvisioningMode[];
  implemented_provisioning_modes: VenueCredentialProvisioningMode[];
  owner_binding: "exact_owner_address" | "verified_owner_association" | "not_supported";
  programmatic_authorizers: Array<Exclude<VenueOwnerAuthorizationSource, "none">>;
  generated_secret_custody: Array<Extract<
    VenueCredentialSecretHandling,
    "turnkey_non_exportable" | "direct_to_attested_runtime"
  >>;
  manual_secret_handling: "direct_to_attested_runtime" | "not_supported";
};

type VenueExecutionCredentialContract = {
  version: 1;
  default_disposition: "blocked";
  silent_provisioning_allowed: false;
  unsafe_execution_permissions: Array<"withdraw" | "transfer" | "credential_admin" | "secret_export">;
  venues: Record<string, VenueCredentialContractEntry>;
};

export const VENUE_EXECUTION_CREDENTIAL_CONTRACT =
  contractJson as VenueExecutionCredentialContract;

export function evaluateVenueExecutionCredential(
  request: VenueExecutionCredentialRequest,
): VenueExecutionCredentialDecision {
  const venueId = request.venue_id.trim().toLowerCase();
  const entry = VENUE_EXECUTION_CREDENTIAL_CONTRACT.venues[venueId];
  const reasons: VenueExecutionCredentialBlockReason[] = [];

  if (!entry || entry.provisioning_modes.length === 0) {
    reasons.push("venue_not_supported");
  } else if (!entry.provisioning_modes.includes(request.provisioning_mode)) {
    reasons.push("provisioning_mode_not_supported");
  } else if (!entry.implemented_provisioning_modes.includes(request.provisioning_mode)) {
    reasons.push("provisioning_mode_not_implemented");
  }

  if (request.silent_provisioning === true) reasons.push("silent_provisioning_blocked");
  if (!request.explicit_owner_authorization) reasons.push("explicit_owner_authorization_required");
  if (!request.owner_binding_verified) reasons.push("owner_binding_required");

  if (request.provisioning_mode === "manual_sealed_import") {
    if (request.secret_handling !== "direct_to_attested_runtime") {
      reasons.push("direct_seal_to_attested_runtime_required");
    }
  } else {
    if (!entry?.programmatic_authorizers.includes(request.owner_authorization_source as Exclude<VenueOwnerAuthorizationSource, "none">)) {
      reasons.push("owner_authorization_source_not_supported");
    }
    if (request.owner_authorization_source === "turnkey_venue_owner" && request.turnkey_role !== "venue_owner") {
      reasons.push("turnkey_must_be_venue_owner");
    }
    if (!entry?.generated_secret_custody.includes(request.secret_handling as "turnkey_non_exportable" | "direct_to_attested_runtime")) {
      reasons.push("programmatic_secret_handling_not_supported");
    }
  }

  const permission = request.permission_attestation;
  if (!permission) {
    reasons.push("permission_attestation_required");
  } else {
    if (!permission.can_read || !permission.can_trade) reasons.push("read_trade_permissions_required");
    if (permission.can_withdraw) reasons.push("withdrawal_permission_blocked");
    if (permission.can_transfer) reasons.push("transfer_permission_blocked");
    if (permission.can_manage_credentials) reasons.push("credential_admin_permission_blocked");
    if (permission.can_export_secret) reasons.push("secret_export_permission_blocked");
    if ((permission.unknown_scopes?.length ?? 0) > 0) reasons.push("unknown_permission_scope_blocked");
  }

  const reasonCodes = Array.from(new Set(reasons));
  if (reasonCodes.length > 0) {
    return {
      allowed: false,
      disposition: "blocked",
      venue_id: venueId,
      provisioning_mode: request.provisioning_mode,
      reason_codes: reasonCodes,
    };
  }

  return {
    allowed: true,
    disposition: request.provisioning_mode === "manual_sealed_import" ? "sealed_import" : "provision",
    venue_id: venueId,
    provisioning_mode: request.provisioning_mode,
  };
}
