import type { Metadata } from "next";
import Link from "next/link";

import { AuthTokenForm } from "../components/console";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hunter Harness Console",
  description: "Human review and governed artifact publishing"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <aside>
            <Link className="brand" href="/"><span>HH</span><div>Hunter Harness<small>Governance Console</small></div></Link>
            <nav><Link href="/">Overview</Link><Link href="/projects">Projects</Link><Link href="/workflows">Harness Workflows</Link><Link href="/skills">Skills</Link><Link href="/proposals">Review queue</Link><Link href="/artifacts">Artifacts</Link></nav>
            <AuthTokenForm />
          </aside>
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
