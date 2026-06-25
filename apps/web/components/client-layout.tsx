"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { I18nProvider, useI18n } from "../lib/i18n";
import { ThemeProvider, useTheme } from "../lib/theme";
import { SettingsPanel } from "./settings-panel";

function Sidebar() {
  const { t } = useI18n();
  const pathname = usePathname();
  const { theme, setTheme } = useTheme();

  function isActive(href: string) {
    if (href === "/") return pathname === href;
    return pathname.startsWith(href);
  }

  return (
    <aside>
      <Link className="brand" href="/">
        <img
          className="brand-logo"
          src={theme === "dark" ? "/logo-dark-mark.png" : "/logo-light-mark.png"}
          alt="Hunter Harness"
        />
        <span className="brand-copy">
          <strong>Harness 工作台</strong>
          <small>Governed developer console</small>
        </span>
      </Link>
      <nav>
        <Link href="/" className={isActive("/") ? "active" : ""}>
          {t.nav.overview}
        </Link>
        <Link href="/projects" className={isActive("/projects") ? "active" : ""}>
          {t.nav.projects}
        </Link>
        <Link href="/workflows" className={isActive("/workflows") ? "active" : ""}>
          {t.nav.workflows}
        </Link>
        <Link href="/skills" className={isActive("/skills") ? "active" : ""}>
          {t.nav.skills}
        </Link>
        <Link href="/ai-config" className={isActive("/ai-config") ? "active" : ""}>
          {t.nav.aiConfig}
        </Link>
        <Link href="/proposals" className={isActive("/proposals") ? "active" : ""}>
          {t.nav.reviewQueue}
        </Link>
        <Link href="/artifacts" className={isActive("/artifacts") ? "active" : ""}>
          {t.nav.artifacts}
        </Link>
      </nav>

      <SettingsPanel theme={theme} setTheme={setTheme} />
    </aside>
  );
}

export function ClientLayout({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <I18nProvider>
        <ClientLayoutInner>{children}</ClientLayoutInner>
      </I18nProvider>
    </ThemeProvider>
  );
}

function ClientLayoutInner({ children }: { children: React.ReactNode }) {
  const { lang, t } = useI18n();
  const demo = process.env.NEXT_PUBLIC_HUNTER_HARNESS_DEMO === "true";

  return (
    <div className="shell">
      <Sidebar />
      <main key={lang}>
        {demo ? <div className="demo-banner">{t.demoBanner}</div> : null}
        {children}
      </main>
    </div>
  );
}
