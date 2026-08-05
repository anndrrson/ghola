export function foundingCheckoutIsOpen(
  enabled: boolean,
  cohort: { checkout_open?: boolean } | null | undefined,
) {
  return enabled && cohort?.checkout_open === true;
}
