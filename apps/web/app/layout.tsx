import type { Metadata } from "next";

import { ClientLayout } from "../components/client-layout";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hunter Harness Console",
  description: "Human review and governed artifact publishing",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh">
      <body>
        <ClientLayout>{children}</ClientLayout>
      </body>
    </html>
  );
}