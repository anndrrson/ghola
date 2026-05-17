"use client";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-4 text-center">
      <h1 className="mb-2 text-4xl font-bold text-[#eef1f8]">
        Something went wrong
      </h1>
      <p className="mb-6 text-[#8b95a8]">{error.message || "An unexpected error occurred"}</p>
      <button
        onClick={reset}
        className="rounded-xl bg-[#3da8ff] px-6 py-3 font-medium text-[#eef1f8] transition hover:bg-[#5bb8ff]"
      >
        Try Again
      </button>
    </div>
  );
}
