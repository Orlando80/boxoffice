import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Not found - Boxoffice admin" };

export default function NotFound() {
  return (
    <>
      <h1>Page not found</h1>
      <p>
        <Link href="/">Back to venues</Link>
      </p>
    </>
  );
}
