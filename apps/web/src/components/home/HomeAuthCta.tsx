"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";

export function HomeAuthCta() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
      <Link
        href="/trade"
        className="group inline-flex h-12 items-center justify-center gap-2 rounded-full bg-[#eef1f8] px-6 text-sm font-medium text-[#08090d] transition hover:bg-white"
      >
        Start live trade
        <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
      </Link>
      <Link
        href="/signin?redirect=/trade"
        className="inline-flex h-12 items-center justify-center rounded-full border border-[#2b3547] px-6 text-sm font-medium text-[#cbd5e1] transition hover:border-[#475569] hover:text-white"
      >
        Sign in
      </Link>
    </div>
  );
}
