import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { claimDemoRoleFn, getSessionProfileFn } from "@/lib/api/auth.functions";
import { resetDemoDataFn } from "@/lib/api/admin.functions";
import { useI18n } from "@/lib/i18n/context";

export const Route = createFileRoute("/_authenticated/account")({
  head: () => ({
    meta: [
      { title: "Account & demo tools — VoucherRail Demo" },
      {
        name: "description",
        content:
          "Inspect your session roles, claim a demo admin or agent role and reset the testnet demo dataset.",
      },
      { property: "og:title", content: "Account & demo tools — VoucherRail Demo" },
      {
        property: "og:description",
        content: "Role claiming and demo data reset tools for the VoucherRail testnet demo.",
      },
    ],
  }),
  component: AccountPage,
});

function AccountPage() {
  const { t } = useI18n();
  const profileFn = useServerFn(getSessionProfileFn);
  const claimFn = useServerFn(claimDemoRoleFn);
  const resetFn = useServerFn(resetDemoDataFn);
  const queryClient = useQueryClient();
  const router = useRouter();

  const [role, setRole] = useState<"admin" | "agent">("admin");
  const [agentRef, setAgentRef] = useState<"AGT-A" | "AGT-B" | "AGT-C">("AGT-A");

  const profile = useQuery({ queryKey: ["session-profile"], queryFn: () => profileFn() });

  const claim = useMutation({
    mutationFn: () =>
      claimFn({ data: role === "agent" ? { role, agentRef } : { role } }),
    onSuccess: (result) => {
      toast.success(`You now have the ${result.role} role`);
      queryClient.invalidateQueries();
      router.invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const reset = useMutation({
    mutationFn: () => resetFn(),
    onSuccess: () => {
      toast.success("Demo dataset regenerated");
      queryClient.invalidateQueries();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t.admin.account.title}</h1>
        <p className="text-sm text-muted-foreground">{t.admin.account.subtitle}</p>
      </div>

      <div className="panel space-y-2 p-4 text-sm">
        <p>
          <span className="text-muted-foreground">Signed in as</span>{" "}
          {profile.data?.email ?? "…"}
        </p>
        <p>
          <span className="text-muted-foreground">Roles</span>{" "}
          <span className="mono-tag">
            {profile.data?.roles.length ? profile.data.roles.join(", ") : "customer"}
          </span>
        </p>
        {profile.data?.agentRef ? (
          <p>
            <span className="text-muted-foreground">Linked agent</span>{" "}
            {profile.data.agentName} ({profile.data.agentRef})
          </p>
        ) : null}
      </div>

      {profile.data && !profile.data.demoToolsEnabled ? (
        <p className="text-sm text-muted-foreground">
          Demo tools (role claiming, dataset reset) are disabled outside DEMO mode — roles are
          provisioned by an operator.
        </p>
      ) : null}

      {profile.data?.demoToolsEnabled ? (
      <div className="panel space-y-4 p-4">
        <div>
          <h2 className="text-sm font-semibold">Claim a demo role</h2>
          <p className="text-xs text-muted-foreground">
            Choosing agent also links your login to one of the seeded agent records.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-2">
            <Label>Role</Label>
            <Select value={role} onValueChange={(value) => setRole(value as "admin" | "agent")}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="admin">Admin</SelectItem>
                <SelectItem value="agent">Agent</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {role === "agent" ? (
            <div className="space-y-2">
              <Label>Agent record</Label>
              <Select
                value={agentRef}
                onValueChange={(value) => setAgentRef(value as "AGT-A" | "AGT-B" | "AGT-C")}
              >
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="AGT-A">AGT-A</SelectItem>
                  <SelectItem value="AGT-B">AGT-B</SelectItem>
                  <SelectItem value="AGT-C">AGT-C</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <Button disabled={claim.isPending} onClick={() => claim.mutate()}>
            {claim.isPending ? "Applying…" : "Claim role"}
          </Button>
        </div>
      </div>
      ) : null}

      {profile.data?.demoToolsEnabled && profile.data.roles.includes("admin") ? (
        <div className="panel space-y-3 p-4">
          <div>
            <h2 className="text-sm font-semibold">Reset demo dataset</h2>
            <p className="text-xs text-muted-foreground">
              Deletes all vouchers, transactions, ledger entries and audit rows, then regenerates
              100 demo vouchers across every lifecycle state.
            </p>
          </div>
          <Button variant="outline" disabled={reset.isPending} onClick={() => reset.mutate()}>
            {reset.isPending ? "Rebuilding…" : "Reset demo data"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
