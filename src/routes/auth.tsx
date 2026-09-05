import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { signInFn, signUpFn } from "@/lib/api/auth.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LanguageSwitcher } from "@/components/language-switcher";
import { useI18n } from "@/lib/i18n/context";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Staff sign in — VoucherRail Demo" },
      {
        name: "description",
        content: "Sign in to the VoucherRail testnet demo console as an admin or agent.",
      },
      { property: "og:title", content: "Staff sign in — VoucherRail Demo" },
      {
        property: "og:description",
        content: "Admin and agent access to the VoucherRail voucher demo console.",
      },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const result = await (mode === "signin" ? signInFn : signUpFn)({
        data: { email: email.trim(), password },
      });
      if (!result.ok) {
        setMessage(result.error);
        return;
      }
      // Not "/" — that page looks identical whether you're signed in or not,
      // which reads as "did that even work?" and invites signing in again.
      // "/account" requires auth and shows "Signed in as ...", so landing
      // there is itself proof the sign-in worked.
      navigate({ to: "/account" });
    } catch (error) {
      setMessage(
        error instanceof Error
          ? `Request failed: ${error.message}`
          : "Request failed. Check your connection and try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid-backdrop flex min-h-screen items-center justify-center px-6 py-12">
      <form onSubmit={submit} className="panel w-full max-w-sm space-y-4 p-6">
        <div className="flex items-start justify-between gap-2">
          <div className="space-y-1">
            <h1 className="text-xl font-semibold">
              {mode === "signin" ? t.auth.signInTitle : t.auth.signUpTitle}
            </h1>
            <p className="mono-tag text-muted-foreground">{t.auth.disclaimer}</p>
          </div>
          <LanguageSwitcher />
        </div>
        <div className="space-y-2">
          <Label htmlFor="email">{t.auth.emailLabel}</Label>
          <Input
            id="email"
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">{t.auth.passwordLabel}</Label>
          <Input
            id="password"
            type="password"
            required
            minLength={6}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        {message ? <p className="text-sm text-warning">{message}</p> : null}
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? t.auth.working : mode === "signin" ? t.auth.signIn : t.auth.signUp}
        </Button>
        <button
          type="button"
          className="w-full text-sm text-muted-foreground underline-offset-4 hover:underline"
          onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
        >
          {mode === "signin" ? t.auth.toggleToSignUp : t.auth.toggleToSignIn}
        </button>
      </form>
    </main>
  );
}
