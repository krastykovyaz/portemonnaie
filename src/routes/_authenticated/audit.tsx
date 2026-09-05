import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listAuditFn } from "@/lib/api/admin.functions";
import { shortDate } from "@/lib/format";
import { useI18n } from "@/lib/i18n/context";

export const Route = createFileRoute("/_authenticated/audit")({
  head: () => ({
    meta: [
      { title: "Audit log — VoucherRail Demo" },
      {
        name: "description",
        content:
          "Immutable record of voucher generation, assignment, sales, redemptions and admin actions.",
      },
      { property: "og:title", content: "Audit log — VoucherRail Demo" },
      {
        property: "og:description",
        content: "Full audit trail of actions in the VoucherRail testnet demo.",
      },
    ],
  }),
  component: AuditPage,
});

function AuditPage() {
  const { t } = useI18n();
  const fn = useServerFn(listAuditFn);
  const { data, isLoading } = useQuery({ queryKey: ["audit"], queryFn: () => fn() });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t.admin.audit.title}</h1>
        <p className="text-sm text-muted-foreground">{t.admin.audit.subtitle}</p>
      </div>

      <div className="panel overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-border text-left text-muted-foreground">
            <tr>
              <th className="p-3 font-medium">When</th>
              <th className="p-3 font-medium">Actor</th>
              <th className="p-3 font-medium">Action</th>
              <th className="p-3 font-medium">Entity</th>
              <th className="p-3 font-medium">Details</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={5} className="p-6 text-center text-muted-foreground">
                  Loading audit log…
                </td>
              </tr>
            ) : (
              (data ?? []).map((row) => (
                <tr key={row.id} className="border-b border-border/50 last:border-0">
                  <td className="p-3 text-muted-foreground">{shortDate(row.created_at)}</td>
                  <td className="p-3">{row.actor_label ?? "system"}</td>
                  <td className="p-3">
                    <span className="mono-tag rounded-full border border-border px-2 py-0.5">
                      {row.action}
                    </span>
                  </td>
                  <td className="p-3 font-mono text-xs">
                    {row.entity}
                    {row.entity_id ? ` · ${row.entity_id}` : ""}
                  </td>
                  <td className="max-w-md truncate p-3 font-mono text-[11px] text-muted-foreground">
                    {JSON.stringify(row.metadata)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
