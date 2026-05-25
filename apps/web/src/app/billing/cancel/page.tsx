import { redirect } from "next/navigation";

export default function BillingCancelPage() {
  redirect("/settings?tab=plan&checkout=cancelled");
}
