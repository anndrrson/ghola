export const VENUE_CREDENTIAL_ONBOARDING_MODES = [
  "wallet_authorized_auto_provisioning",
  "programmatic_key_one_owner_signature",
  "venue_controlled_owner_association",
  "manual_only",
] as const;

export type VenueCredentialOnboardingMode = typeof VENUE_CREDENTIAL_ONBOARDING_MODES[number];
export type CredentialOnboardingVenue = CarryExecutionVenue;
export type CredentialPathAvailability = "available" | "feature_gated" | "documented_not_implemented";

export interface VenueCredentialOnboardingPath {
  mode: VenueCredentialOnboardingMode;
  availability: CredentialPathAvailability;
  credential_custody: "turnkey_managed" | "browser_generated_encrypted" | "attested_worker_generated_sealed" | "user_supplied_sealed";
  requires_wallet_authentication: boolean;
  requires_one_owner_signature: boolean;
  requires_venue_controlled_association: boolean;
  requires_manual_secret_entry: boolean;
  generates_credential: boolean;
  registers_credential: boolean;
  may_place_trade_during_setup: false;
  requirements: readonly string[];
  ux: Readonly<{
    badge: string;
    action_label: string;
    title: string;
    description: string;
    safety_note: string;
  }>;
}

export interface VenueCredentialOnboardingCapability {
  venue_id: CredentialOnboardingVenue;
  /** Strongest path proven by shipped code or official venue documentation. */
  highest_proven_mode: VenueCredentialOnboardingMode;
  /** Path that Ghola can truthfully present as the default today. */
  current_mode: VenueCredentialOnboardingMode;
  paths: readonly VenueCredentialOnboardingPath[];
}

const HYPERLIQUID: VenueCredentialOnboardingCapability = {
  venue_id: "hyperliquid",
  highest_proven_mode: "wallet_authorized_auto_provisioning",
  current_mode: "wallet_authorized_auto_provisioning",
  paths: [
    {
      mode: "wallet_authorized_auto_provisioning",
      availability: "available",
      credential_custody: "turnkey_managed",
      requires_wallet_authentication: true,
      requires_one_owner_signature: false,
      requires_venue_controlled_association: false,
      requires_manual_secret_entry: false,
      generates_credential: true,
      registers_credential: true,
      may_place_trade_during_setup: false,
      requirements: [
        "Turnkey must be configured and the user must authenticate its wallet activity.",
        "Turnkey must control the Hyperliquid owner account; an external owner uses the one-signature path instead.",
      ],
      ux: {
        badge: "Wallet-authorized setup",
        action_label: "Set up with wallet",
        title: "Hyperliquid wallet setup",
        description: "Authenticate once. Ghola creates the dedicated wallet set and requests the scoped venue authorization.",
        safety_note: "Setup creates and authorizes credentials only. It never places a trade.",
      },
    },
    {
      mode: "programmatic_key_one_owner_signature",
      availability: "feature_gated",
      credential_custody: "browser_generated_encrypted",
      requires_wallet_authentication: true,
      requires_one_owner_signature: true,
      requires_venue_controlled_association: false,
      requires_manual_secret_entry: false,
      generates_credential: true,
      registers_credential: true,
      may_place_trade_during_setup: false,
      requirements: ["Legacy Hyperliquid API-key setup must be enabled and an injected EVM owner wallet must be available."],
      ux: {
        badge: "One owner approval",
        action_label: "Connect wallet & authorize",
        title: "Create a trade-only wallet",
        description: "Ghola creates one encrypted API wallet; the collateral owner explicitly approves that exact address once.",
        safety_note: "The generated API wallet cannot withdraw, and setup never places a trade.",
      },
    },
    {
      mode: "manual_only",
      availability: "feature_gated",
      credential_custody: "user_supplied_sealed",
      requires_wallet_authentication: false,
      requires_one_owner_signature: false,
      requires_venue_controlled_association: false,
      requires_manual_secret_entry: true,
      generates_credential: false,
      registers_credential: false,
      may_place_trade_during_setup: false,
      requirements: ["Legacy Hyperliquid API-key setup must be enabled and the API wallet must already be authorized."],
      ux: {
        badge: "Existing API wallet",
        action_label: "Enter existing wallet",
        title: "Use an existing API wallet",
        description: "Enter an already-authorized Hyperliquid API wallet and seal it to the private worker.",
        safety_note: "Never enter the collateral owner's main private key.",
      },
    },
  ],
};

const LIGHTER: VenueCredentialOnboardingCapability = {
  venue_id: "lighter",
  highest_proven_mode: "programmatic_key_one_owner_signature",
  current_mode: "programmatic_key_one_owner_signature",
  paths: [
    {
      mode: "programmatic_key_one_owner_signature",
      availability: "available",
      credential_custody: "attested_worker_generated_sealed",
      requires_wallet_authentication: true,
      requires_one_owner_signature: true,
      requires_venue_controlled_association: false,
      requires_manual_secret_entry: false,
      generates_credential: true,
      registers_credential: true,
      may_place_trade_during_setup: false,
      requirements: [
        "Generate the specialized Lighter signer inside the attested worker and return only its public key.",
        "Verify the exact Lighter account, vacant API-key slot, mainnet proxy, and simulated ChangePubKey transaction.",
        "Sign the exact zero-value ChangePubKey transaction with the non-exportable Turnkey owner, then verify its receipt and Lighter association without retrying ambiguity.",
      ],
      ux: {
        badge: "One owner approval",
        action_label: "Create key & authorize",
        title: "Connect Lighter securely",
        description: "Ghola creates and seals the key, then your Turnkey owner approves its exact Lighter association once.",
        safety_note: "Your owner key never leaves Turnkey. Ghola cannot trade until Ethereum and Lighter both confirm the association.",
      },
    },
    {
      mode: "manual_only",
      availability: "available",
      credential_custody: "user_supplied_sealed",
      requires_wallet_authentication: false,
      requires_one_owner_signature: false,
      requires_venue_controlled_association: false,
      requires_manual_secret_entry: true,
      generates_credential: false,
      registers_credential: false,
      may_place_trade_during_setup: false,
      requirements: ["The Lighter API key and its account and key indexes must already exist."],
      ux: {
        badge: "Guided existing-key setup",
        action_label: "Enter existing key",
        title: "Connect a Lighter API key",
        description: "Enter an existing Lighter key and its indexes; Ghola validates and seals them to the private worker.",
        safety_note: "Lighter keys are not venue-native trade-only; Ghola blocks transfer and withdrawal operations at its policy boundary.",
      },
    },
  ],
};

const ASTER: VenueCredentialOnboardingCapability = {
  venue_id: "aster",
  highest_proven_mode: "programmatic_key_one_owner_signature",
  current_mode: "programmatic_key_one_owner_signature",
  paths: [
    {
      mode: "programmatic_key_one_owner_signature",
      availability: "available",
      credential_custody: "attested_worker_generated_sealed",
      requires_wallet_authentication: true,
      requires_one_owner_signature: true,
      requires_venue_controlled_association: false,
      requires_manual_secret_entry: false,
      generates_credential: true,
      registers_credential: true,
      may_place_trade_during_setup: false,
      requirements: [
        "Generate the Aster signer inside the attested worker and return only its public address.",
        "Register and authorize the exact generated signer through Aster V3 with canPerpTrade=true and canWithdraw=false.",
      ],
      ux: {
        badge: "One owner approval",
        action_label: "Create signer & authorize",
        title: "Create an Aster trading signer",
        description: "Ghola creates the signer inside the attested worker, then your Aster owner approves that exact address once.",
        safety_note: "The signer never leaves the worker, cannot withdraw, and setup never places a trade.",
      },
    },
    {
      mode: "manual_only",
      availability: "available",
      credential_custody: "user_supplied_sealed",
      requires_wallet_authentication: false,
      requires_one_owner_signature: false,
      requires_venue_controlled_association: false,
      requires_manual_secret_entry: true,
      generates_credential: false,
      registers_credential: false,
      may_place_trade_during_setup: false,
      requirements: ["An Aster trading wallet must already be authorized by the collateral owner."],
      ux: {
        badge: "Existing trading wallet",
        action_label: "Enter existing wallet",
        title: "Connect an Aster trading wallet",
        description: "Enter an already-authorized Aster trading wallet; Ghola derives its address and seals the credential.",
        safety_note: "Never enter the collateral owner's main private key.",
      },
    },
  ],
};

export const VENUE_CREDENTIAL_ONBOARDING = Object.freeze({
  hyperliquid: HYPERLIQUID,
  lighter: LIGHTER,
  aster: ASTER,
}) satisfies Readonly<Record<CredentialOnboardingVenue, VenueCredentialOnboardingCapability>>;

export function getVenueCredentialOnboardingCapability(venue: CredentialOnboardingVenue) {
  return VENUE_CREDENTIAL_ONBOARDING[venue];
}

export function getCurrentVenueCredentialOnboardingPath(venue: CredentialOnboardingVenue) {
  const capability = getVenueCredentialOnboardingCapability(venue);
  const path = capability.paths.find((candidate) =>
    candidate.mode === capability.current_mode && candidate.availability === "available",
  );
  if (!path) throw new Error(`venue_credential_onboarding_current_path_unavailable:${venue}`);
  return path;
}

export function getVenueCredentialOnboardingPath(
  venue: CredentialOnboardingVenue,
  mode: VenueCredentialOnboardingMode,
) {
  return getVenueCredentialOnboardingCapability(venue).paths.find((path) => path.mode === mode) ?? null;
}
import type { CarryExecutionVenue } from "./carry-venues";
