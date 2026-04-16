export function ComingSoonPage({
	title,
	phase,
	description,
}: {
	title: string;
	phase: string;
	description: string;
}) {
	return (
		<>
			<header className="flex justify-between items-start mb-6 gap-4">
				<div>
					<h1 className="font-serif text-[24px] leading-[1.15] text-text">{title}</h1>
					<div className="text-[12px] text-text-3 mt-[3px]">{description}</div>
				</div>
				<span className="badge bg-amber-bg text-amber">{phase}</span>
			</header>
			<div className="card">
				<div className="card-title">Planned</div>
				<p className="text-[13px] text-text-2 leading-relaxed">
					This page is scaffolded but not wired yet. It lands in the next shipping phase. The
					design mirrors the reference MIS and will pull from real ERPNext data — no
					placeholders.
				</p>
			</div>
		</>
	);
}
