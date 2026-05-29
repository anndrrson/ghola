"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useThumperAuth } from "@/lib/thumper-auth-context";
import { mark } from "@/lib/perf-marks";

export function HomeSignedInRedirect() {
  const { authenticated, loading } = useThumperAuth();
  const router = useRouter();

  useEffect(() => {
    mark("hero-rendered");
  }, []);

  useEffect(() => {
    if (!loading && authenticated) {
      router.replace("/app/account?flow=trade");
    }
  }, [authenticated, loading, router]);

  return null;
}
