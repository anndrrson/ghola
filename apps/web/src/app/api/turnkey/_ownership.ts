import { Turnkey } from "@turnkey/sdk-server";

type TurnkeyApiClient = ReturnType<InstanceType<typeof Turnkey>["apiClient"]>;

export async function sessionOwnsTurnkeyWallet({
  client,
  parentOrganizationId,
  sessionEmail,
  subOrganizationId,
  walletAddress,
}: {
  client: TurnkeyApiClient;
  parentOrganizationId: string;
  sessionEmail: string;
  subOrganizationId: string;
  walletAddress: string;
}) {
  const email = sessionEmail.trim().toLowerCase();
  if (!email || !subOrganizationId || !walletAddress) return false;

  const organizations = await client.getSubOrgIds({
    organizationId: parentOrganizationId,
    filterType: "EMAIL",
    filterValue: email,
  });
  if (!organizations.organizationIds?.includes(subOrganizationId)) return false;

  const wallets = await client.getWallets({ organizationId: subOrganizationId });
  for (const wallet of wallets.wallets || []) {
    const accounts = await client.getWalletAccounts({
      organizationId: subOrganizationId,
      walletId: wallet.walletId,
    });
    if (accounts.accounts?.some((account) => account.address === walletAddress)) return true;
  }
  return false;
}
