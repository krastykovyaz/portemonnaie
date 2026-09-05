import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import {
  assignVouchersFn,
  listAgentsFn,
  listVouchersFn,
  voucherActionFn,
} from "@/lib/api/admin.functions";
import { money, shortDate, statusTone } from "@/lib/format";
import type { VoucherStatus } from "@/lib/domain/types";
import { useI18n } from "@/lib/i18n/context";

export const Route = createFileRoute("/_authenticated/vouchers")({
  head: () => ({
    meta: [
      { title: "Vouchers — VoucherRail Demo" },
      {
        name: "description",
        content:
          "Search, filter, assign, block and cancel testnet vouchers across their full lifecycle.",
      },
      { property: "og:title", content: "Vouchers — VoucherRail Demo" },
      {
        property: "og:description",
        content: "Voucher inventory management for the VoucherRail testnet demo.",
      },
    ],
  }),
  component: VouchersPage,
});

const STATUSES: Array<VoucherStatus | "ALL"> = [
  "ALL",
  "CREATED",
  "ASSIGNED",
  "SOLD",
  "REDEEMING",
  "REDEEMED",
  "BLOCKED",
  "EXPIRED",
  "CANCELLED",
];

function VouchersPage() {
  const { t } = useI18n();
  const listFn = useServerFn(listVouchersFn);
  const agentsFn = useServerFn(listAgentsFn);
  const assignFn = useServerFn(assignVouchersFn);
  const actionFn = useServerFn(voucherActionFn);
  const queryClient = useQueryClient();

  const [status, setStatus] = useState<string>("ALL");
  const [agentId, setAgentId] = useState<string>("ALL");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [assignTo, setAssignTo] = useState<string>("");

  const vouchers = useQuery({
    queryKey: ["vouchers", status, agentId, search],
    queryFn: () =>
      listFn({
        data: {
          status,
          ...(agentId === "ALL" ? {} : { agentId }),
          search: search.trim(),
        },
      }),
  });
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => agentsFn() });

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ["vouchers"] });
    queryClient.invalidateQueries({ queryKey: ["admin-overview"] });
  }

  const assign = useMutation({
    mutationFn: () => assignFn({ data: { voucherIds: selected, agentId: assignTo } }),
    onSuccess: (result) => {
      toast.success(`Assigned ${result.assigned} voucher(s)`);
      setSelected([]);
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const act = useMutation({
    mutationFn: (input: { voucherId: string; action: "BLOCK" | "CANCEL" | "UNBLOCK" }) =>
      actionFn({ data: input }),
    onSuccess: () => {
      toast.success("Voucher updated");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rows = vouchers.data ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t.admin.vouchers.title}</h1>
        <p className="text-sm text-muted-foreground">{t.admin.vouchers.subtitle}</p>
      </div>

      <div className="panel grid gap-4 p-4 md:grid-cols-4">
        <div className="space-y-2">
          <Label>Status</Label>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Agent</Label>
          <Select value={agentId} onValueChange={setAgentId}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All agents</SelectItem>
              {(agents.data ?? []).map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  {agent.name} ({agent.agent_ref})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2 md:col-span-2">
          <Label htmlFor="search">Search voucher ID</Label>
          <Input
            id="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="VDEMO0001"
            className="font-mono uppercase"
          />
        </div>
      </div>

      {selected.length > 0 ? (
        <div className="panel flex flex-wrap items-end gap-3 p-4">
          <div className="space-y-2">
            <Label>Assign {selected.length} selected to</Label>
            <Select value={assignTo} onValueChange={setAssignTo}>
              <SelectTrigger className="w-64">
                <SelectValue placeholder="Choose agent" />
              </SelectTrigger>
              <SelectContent>
                {(agents.data ?? []).map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    {agent.name} ({agent.agent_ref})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button disabled={!assignTo || assign.isPending} onClick={() => assign.mutate()}>
            {assign.isPending ? "Assigning…" : "Assign"}
          </Button>
          <Button variant="ghost" onClick={() => setSelected([])}>
            Clear
          </Button>
        </div>
      ) : null}

      <div className="panel overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-border text-left text-muted-foreground">
            <tr>
              <th className="w-10 p-3" />
              <th className="p-3 font-medium">Voucher</th>
              <th className="p-3 font-medium">Value</th>
              <th className="p-3 font-medium">Status</th>
              <th className="p-3 font-medium">Agent</th>
              <th className="p-3 font-medium">Created</th>
              <th className="p-3 font-medium">Expires</th>
              <th className="p-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {vouchers.isLoading ? (
              <tr>
                <td colSpan={8} className="p-6 text-center text-muted-foreground">
                  Loading vouchers…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="p-6 text-center text-muted-foreground">
                  No vouchers match these filters.
                </td>
              </tr>
            ) : (
              rows.map((voucher) => {
                const selectable = voucher.status === "CREATED" || voucher.status === "ASSIGNED";
                return (
                  <tr key={voucher.id} className="border-b border-border/50 last:border-0">
                    <td className="p-3">
                      {selectable ? (
                        <Checkbox
                          checked={selected.includes(voucher.id)}
                          onCheckedChange={(checked) =>
                            setSelected((prev) =>
                              checked ? [...prev, voucher.id] : prev.filter((id) => id !== voucher.id),
                            )
                          }
                          aria-label={`Select ${voucher.public_id}`}
                        />
                      ) : null}
                    </td>
                    <td className="p-3 font-mono text-xs">{voucher.public_id}</td>
                    <td className="p-3">{money(Number(voucher.denomination))}</td>
                    <td className="p-3">
                      <span
                        className={`mono-tag rounded-full border px-2 py-0.5 ${statusTone(voucher.status)}`}
                      >
                        {voucher.status}
                      </span>
                    </td>
                    <td className="p-3">{voucher.agent_name ?? "—"}</td>
                    <td className="p-3 text-muted-foreground">{shortDate(voucher.created_at)}</td>
                    <td className="p-3 text-muted-foreground">{shortDate(voucher.expires_at)}</td>
                    <td className="p-3">
                      <div className="flex gap-2">
                        {voucher.status === "BLOCKED" ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              act.mutate({ voucherId: voucher.id, action: "UNBLOCK" })
                            }
                          >
                            Unblock
                          </Button>
                        ) : ["CREATED", "ASSIGNED", "SOLD"].includes(voucher.status) ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => act.mutate({ voucherId: voucher.id, action: "BLOCK" })}
                          >
                            Block
                          </Button>
                        ) : null}
                        {["CREATED", "ASSIGNED"].includes(voucher.status) ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => act.mutate({ voucherId: voucher.id, action: "CANCEL" })}
                          >
                            Cancel
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
