/** "How the ladder is made" footnote: one line per tier, every figure explainable. Built
 *  from the API's tier components, so it can never drift from the tiles. */
import { Explain } from "@/components/explain/Explain";
import { STEP_FLAG } from "@/lib/pnl";
import { absINR, explainStep, type ExplainCtx } from "@/lib/explain";
import { formatINR } from "@/lib/utils";
import type { ComingSoonTiles } from "@/lib/boot";
import type { ApiPnlStep, PnlStepKey } from "@/types/mis";

export function LadderFootnote({
	steps,
	ctx,
	flags,
	glNetProfit,
}: {
	steps: ApiPnlStep[];
	ctx: ExplainCtx;
	flags: ComingSoonTiles;
	glNetProfit: number;
}) {
	const byKey = new Map(steps.map((s) => [s.key, s] as const));
	const hidden = (k: PnlStepKey) => {
		const f = STEP_FLAG[k];
		return Boolean((f && flags[f]) || (k === "cm1" && flags.gross_profit));
	};
	const num = (k: PnlStepKey, amount: number, signed = false) => {
		const s = byKey.get(k);
		const text = signed ? formatINR(amount) : absINR(amount);
		if (!s || hidden(k)) return <span>{hidden(k) ? "(soon)" : text}</span>;
		return (
			<Explain content={() => explainStep(s, ctx)} label={`${s.label}, ${formatINR(amount)}, has breakdown`}>
				{text}
			</Explain>
		);
	};
	const tiers = steps.filter((s) => s.kind === "tier");
	return (
		<div className="mt-3 text-[11px] text-text-3 leading-[2]">
			{tiers.map((t) => {
				const comps = t.components ?? [];
				return (
					<div key={t.key} className="flex flex-wrap items-baseline gap-x-1.5">
						<span className="font-semibold text-text-2">{t.label.split("·")[0].trim()}</span>
						<span className="text-text-2 font-semibold">{num(t.key, t.subtotal, true)}</span>
						<span>=</span>
						{comps.map((c, i) => {
							const step = byKey.get(c.key);
							const name = shortName(step?.label ?? c.label, i > 0);
							return (
								<span key={c.key} className="inline-flex items-baseline gap-1">
									{i > 0 && <span>{c.amount > 0 ? "+" : "−"}</span>}
									<span>{name}</span>
									{num(c.key, c.amount, i === 0)}
								</span>
							);
						})}
						{t.key === "pat" && !hidden("pat") && (
							<span className={Math.abs(t.subtotal - glNetProfit) <= 1 ? "text-green" : "text-amber"}>
								· ties to GL net profit {formatINR(glNetProfit)} {Math.abs(t.subtotal - glNetProfit) <= 1 ? "✓" : "⚠"}
							</span>
						)}
					</div>
				);
			})}
		</div>
	);
}

/** "CM1 · Gross margin" → "CM1"; later terms in lower case ("freight"), acronyms kept. */
function shortName(label: string, lower: boolean): string {
	const n = label.split("·")[0].trim();
	if (!lower || /^[A-Z0-9&]+$/.test(n.split(" ")[0])) return n;
	return n.charAt(0).toLowerCase() + n.slice(1);
}
