import { redirect } from "next/navigation";

export default function BillingSuccessPage() {
  redirect("/settings?tab=plan&checkout=success");
}
