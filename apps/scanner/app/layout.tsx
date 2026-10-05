import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { RegisterSw } from "./register-sw";

export const metadata: Metadata = {
  title: "Boxoffice scanner",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-GB">
      <body>
        <RegisterSw />
        {children}
      </body>
    </html>
  );
}
