import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listAgentsFn } from "@/lib/api/admin.functions";
import { money } from "@/lib/format";
import { useI18n } from "@/lib/i18n/context";

export const Route = createFileRoute("/_authenticated/agents")({
  head: () => ({
    meta: [
      { title: "Agents — VoucherRail Demo" },
      {
        name: "description",
        content: "Agent inventory, sales volume and simulated commission for the testnet demo.",
      },
      { property: "og:title", content: "Agents — VoucherRail Demo" },
      {
        property: "og:description",
        content: "Agent performance and commission overview in the VoucherRail testnet demo.",
      },
    ],
  }),
  component: AgentsPage,
});

function AgentsPage() {
  const { t } = useI18n();
  const fn = useServerFn(listAgentsFn);
  const { data, isLoading } = useQuery({ queryKey: ["agents-full"], queryFn: () => fn() });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t.admin.agents.title}</h1>
        <p className="text-sm text-muted-foreground">{t.admin.agents.subtitle}</p>
      </div>

      <div className="panel overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-border text-left text-muted-foreground">
            <tr>
              <th className="p-3 font-medium">Agent</th>
              <th className="p-3 font-medium">Ref</th>
              <th className="p-3 font-medium">Inventory</th>
              <th className="p-3 font-medium">Sold</th>
              <th className="p-3 font-medium">Redeemed</th>
              <th className="p-3 font-medium">Sales value</th>
              <th className="p-3 font-medium">Rate</th>
              <th className="p-3 font-medium">Commission</th>
              <th className="p-3 font-medium">Linked login</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={9} className="p-6 text-center text-muted-foreground">
                  Loading agents…
                </td>
              </tr>
            ) : (
              (data ?? []).map((agent) => (
                <tr key={agent.id} className="border-b border-border/50 last:border-0">
                  <td className="p-3">{agent.name}</td>
                  <td className="p-3 font-mono text-xs">{agent.agent_ref}</td>
                  <td className="p-3">{agent.inventory}</td>
                  <td className="p-3">{agent.sold}</td>
                  <td className="p-3">{agent.redeemed}</td>
                  <td className="p-3">{money(agent.salesValue)}</td>
                  <td className="p-3">{(Number(agent.commission_rate) * 100).toFixed(2)}%</td>
                  <td className="p-3">{money(agent.commission)}</td>
                  <td className="p-3 text-muted-foreground">
                    {agent.user_id ? "Linked" : "Not linked"}
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
