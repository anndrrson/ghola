import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-4 text-center">
      <h1 className="mb-2 text-6xl font-bold text-[#eef1f8]">404</h1>
      <p className="mb-6 text-lg text-[#8b95a8]">Page not found</p>
      <Link
        href="/"
        className="rounded-xl bg-[#D4A04A] px-6 py-3 font-medium text-[#eef1f8] transition hover:bg-[#C49240]"
      >
        Go Home
      </Link>
    </div>
  );
}
