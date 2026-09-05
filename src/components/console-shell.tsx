import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { LanguageSwitcher } from "@/components/language-switcher";
import { getSessionProfileFn, signOutFn } from "@/lib/api/auth.functions";
import { useI18n } from "@/lib/i18n/context";
import type { Dictionary } from "@/lib/i18n/en";

export function useSessionProfile() {
  const fn = useServerFn(getSessionProfileFn);
  return useQuery({ queryKey: ["session-profile"], queryFn: () => fn() });
}

function adminLinks(t: Dictionary) {
  return [
    { to: "/dashboard", label: t.nav.overview },
    { to: "/orders", label: t.nav.orders },
    { to: "/vouchers", label: t.nav.vouchers },
    { to: "/batches", label: t.nav.batches },
    { to: "/agents", label: t.nav.agents },
    { to: "/payouts", label: t.nav.payouts },
    { to: "/transactions", label: t.nav.transactions },
    { to: "/ops", label: t.nav.operations },
    { to: "/ledger", label: t.nav.ledger },
    { to: "/audit", label: t.nav.auditLog },
  ] as const;
}

export function ConsoleShell({ children }: { children: ReactNode }) {
  const { data: profile } = useSessionProfile();
  const navigate = useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const roles = profile?.roles ?? [];
  const ADMIN_LINKS = adminLinks(t);

  const signOutServerFn = useServerFn(signOutFn);
  async function signOut() {
    await queryClient.cancelQueries();
    queryClient.clear();
    await signOutServerFn();
    router.invalidate();
    navigate({ to: "/auth", replace: true });
  }

  return (
    <div className="grid-backdrop min-h-screen">
      <header className="border-b border-border/70 bg-surface/60 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-4 px-6 py-4">
          <Link to="/" className="flex items-center gap-3">
            <div className="flex size-8 items-center justify-center rounded-lg bg-primary font-mono text-xs font-bold text-primary-foreground">
              VR
            </div>
            <span className="font-semibold">{t.common.appName}</span>
          </Link>
          <span className="mono-tag rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-warning">
            {t.common.demoTestnet}
          </span>
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden text-sm text-muted-foreground sm:inline">
              {profile?.email ?? "…"}
              {roles.length ? ` · ${roles.join(", ")}` : ""}
            </span>
            <LanguageSwitcher />
            <Button variant="outline" size="sm" onClick={signOut}>
              {t.common.signOut}
            </Button>
          </div>
        </div>
        <nav className="mx-auto flex max-w-7xl flex-wrap gap-1 px-4 pb-3">
          {roles.includes("admin")
            ? ADMIN_LINKS.map((link) => (
                <Link
                  key={link.to}
                  to={link.to}
                  className="rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[status=active]:bg-accent data-[status=active]:text-foreground"
                >
                  {link.label}
                </Link>
              ))
            : null}
          {roles.includes("agent") ? (
            <Link
              to="/agent"
              className="rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[status=active]:bg-accent data-[status=active]:text-foreground"
            >
              {t.nav.agentWorkspace}
            </Link>
          ) : null}
          <Link
            to="/account"
            className="rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[status=active]:bg-accent data-[status=active]:text-foreground"
          >
            {t.nav.accountRoles}
          </Link>
        </nav>
      </header>
      <main className="mx-auto w-full max-w-7xl px-6 py-8">{children}</main>
    </div>
  );
}
