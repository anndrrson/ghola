export const PRIVATE_ACCOUNT_LIVE_MUTATION_PATHS = [
  /^\/v1\/private-account\/actions\/execute$/,
  /^\/v1\/private-account\/agent-passport\/arm-arb$/,
  /^\/v1\/private-account\/autopilot\/sessions$/,
  /^\/v1\/private-account\/autopilot\/sessions\/[^/]+$/,
  /^\/v1\/private-account\/autopilot\/sessions\/[^/]+\/(?:pause|resume|kill)$/,
  /^\/v1\/private-account\/balance\/import-credit$/,
  /^\/v1\/private-account\/connectors\/(?:submit|verify-no-submit|reconcile)$/,
  /^\/v1\/private-account\/funding\/import$/,
  /^\/v1\/private-account\/hyperliquid\/(?:account-snapshot|managed-allocation)$/,
  /^\/v1\/private-account\/hyperliquid\/agent\/session$/,
  /^\/v1\/private-account\/hyperliquid\/vault$/,
  /^\/v1\/private-account\/omnibus\/(?:allocate|reconcile)$/,
  /^\/v1\/private-account\/platforms\/(?:aster|lighter)\/(?:prepare|complete)$/,
  /^\/v1\/private-account\/platforms\/aster\/activate\/(?:prepare|complete)$/,
  /^\/v1\/private-account\/platforms\/lighter\/recovery\/prepare$/,
  /^\/v1\/private-account\/platforms\/link$/,
  /^\/v1\/private-account\/venues\/[^/]+\/(?:agent\/session|eligibility|pool\/allocate|preflight|reconcile|secret-handles\/create|stealth-account\/create|vault)$/,
] as const;

export function isPrivateAccountLiveMutationPath(pathname: string): boolean {
  return PRIVATE_ACCOUNT_LIVE_MUTATION_PATHS.some((pattern) => pattern.test(pathname));
}

export function allowsSerializedOwnerTransaction(pathname: string): boolean {
  return pathname === "/v1/private-account/platforms/lighter/complete";
}
