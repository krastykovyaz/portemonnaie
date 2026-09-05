import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { meFn } from "@/lib/api/auth.functions";
import { ConsoleShell } from "@/components/console-shell";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const user = await meFn();
    if (!user) throw redirect({ to: "/auth" });
    return { user };
  },
  component: () => (
    <ConsoleShell>
      <Outlet />
    </ConsoleShell>
  ),
});
