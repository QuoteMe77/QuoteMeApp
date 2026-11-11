import { COST_DEPTS, type CostView } from "@/lib/costBreakdown";

const money = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Cost split by department (whole job + by room). Plain markup, so it works in server and client pages.
export default function CostBreakdown({
  view,
  subtotal,
  markupAmount,
  total,
  title = "Profit & cost breakdown",
  open = false,
}: {
  view: CostView;
  subtotal: number;
  markupAmount: number;
  total: number;
  title?: string;
  open?: boolean;
}) {
  return (
      <section className="mt-4 rounded-lg border border-line bg-paper-raised p-4">
        <details open={open}>
          <summary className="cursor-pointer font-semibold">
            {title} — profit ${money(markupAmount)} ({total > 0 ? ((markupAmount / total) * 100).toFixed(1) : "0.0"}% of sell price)
          </summary>
          <div className="mt-3 text-sm space-y-4">
            <p>
              Sell price <b className="font-mono">${money(total)}</b> = cost <b className="font-mono">${money(subtotal)}</b> + your markup (profit){" "}
              <b className="font-mono">${money(markupAmount)}</b>. The cost is what the price book allows, split into the departments below.
            </p>

            {(() => {
              const known = Math.max(0, subtotal - view.unallocated - view.estimated);
              const pct = (v: number) => (subtotal > 0 ? ((v / subtotal) * 100).toFixed(0) : "0");
              return (
                <p className={view.unallocated > 0.005 ? "rounded bg-amber-50 border border-amber-300 px-3 py-2 text-amber-900" : "text-ink-soft"}>
                  Department split: <b>{pct(known)}%</b> of the cost is from your spreadsheet, <b>{pct(view.estimated)}%</b> is estimated (rows your
                  spreadsheet doesn&apos;t list — labour copied from the same cabinet type, material is what&apos;s left), and{" "}
                  <b>{pct(view.unallocated)}%</b> has no split yet.
                </p>
              );
            })()}

            <div>
              <div className="font-semibold text-ink-soft border-b border-line pb-1 mb-1">Whole job — what the price allows for each department</div>
              <div className="grid grid-cols-[1fr_auto_4rem] gap-x-4 gap-y-0.5">
                {COST_DEPTS.map((d) => (
                  <div key={d.key} className="contents">
                    <span>{d.label}</span>
                    <span className="text-right font-mono">${money(view.depts[d.key])}</span>
                    <span className="text-right font-mono text-ink-soft">{subtotal > 0 ? ((view.depts[d.key] / subtotal) * 100).toFixed(1) : "0.0"}%</span>
                  </div>
                ))}
                {view.unallocated > 0.005 && (
                  <div className="contents text-ink-soft">
                    <span>No split yet</span>
                    <span className="text-right font-mono">${money(view.unallocated)}</span>
                    <span className="text-right font-mono">{((view.unallocated / subtotal) * 100).toFixed(1)}%</span>
                  </div>
                )}
                <div className="contents font-semibold">
                  <span className="border-t border-line-strong pt-1">Total cost</span>
                  <span className="text-right font-mono border-t border-line-strong pt-1">${money(subtotal)}</span>
                  <span className="border-t border-line-strong pt-1" />
                </div>
                <div className="contents">
                  <span>+ Markup (profit)</span>
                  <span className="text-right font-mono">${money(markupAmount)}</span>
                  <span />
                </div>
                <div className="contents font-semibold">
                  <span>Sell price (ex GST)</span>
                  <span className="text-right font-mono">${money(total)}</span>
                  <span />
                </div>
              </div>
            </div>

            <div>
              <div className="font-semibold text-ink-soft border-b border-line pb-1 mb-1">By room — what the price allows for each department</div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-ink-soft">
                      <th className="text-left font-semibold py-1 pr-2">Room</th>
                      {COST_DEPTS.map((d) => (
                        <th key={d.key} className="text-right font-semibold px-2">{d.label}</th>
                      ))}
                      <th className="text-right font-semibold px-2">No split</th>
                      <th className="text-right font-semibold px-2">Cost</th>
                      <th className="text-right font-semibold pl-2">Profit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.rooms.map(([a, r]) => (
                      <tr key={a} className="border-t border-line">
                        <td className="py-1 pr-2">{a}</td>
                        {COST_DEPTS.map((d) => (
                          <td key={d.key} className="text-right font-mono px-2">${money(r.depts[d.key])}</td>
                        ))}
                        <td className="text-right font-mono px-2 text-ink-soft">{r.unalloc > 0.005 ? `$${money(r.unalloc)}` : "–"}</td>
                        <td className="text-right font-mono px-2 font-semibold">${money(r.total)}</td>
                        <td className="text-right font-mono pl-2">${money(r.profit)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {view.missing.length > 0 && (
              <details>
                <summary className="cursor-pointer text-ink-soft">{view.missing.length} line(s) with no department split yet</summary>
                <ul className="mt-1 text-xs space-y-0.5">
                  {view.missing.map((m, i) => (
                    <li key={i} className="flex justify-between gap-3">
                      <span className="truncate">{m.area} — {m.name}</span>
                      <span className="font-mono shrink-0">${money(m.cost)}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <p className="text-xs text-ink-soft">POA items are excluded. Profit per room is the markup % on that room&apos;s cost.</p>
          </div>
        </details>
      </section>
  );
}
