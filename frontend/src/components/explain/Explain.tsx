/** <Explain> — a number that explains itself.
 *
 *  Ladder of disclosure:
 *   - desktop (hover: hover, pointer: fine): hover ~350 ms → non-modal preview popover
 *     (hoverable, 150 ms grace, Esc dismisses); click / Enter / Space pins it.
 *   - touch: tap → bottom sheet (modal, drag handle + close); long-press (500 ms, cancelled
 *     by > 10 px movement) is an accelerator for the same sheet.
 *   - "Open breakdown ↗" etc. are real <a target="_blank"> links.
 *
 *  One shared popover / sheet for the whole app (ExplainProvider), so dense tables never
 *  stack or flicker: moving between triggers while a preview is open swaps it instantly. */
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import * as Popover from "@radix-ui/react-popover";
import * as Dialog from "@radix-ui/react-dialog";
import { cn, formatINR, formatPct } from "@/lib/utils";
import { explainAriaLabel, type ExplainContent, type ExplainRow } from "@/lib/explain";

const OPEN_DELAY = 350;
const CLOSE_GRACE = 150;
const LONG_PRESS = 500;
const MOVE_TOLERANCE = 10;

type Measurable = { getBoundingClientRect: () => DOMRect };

interface Active {
	id: string;
	anchor: Measurable;
	/** Element to return focus to. */
	trigger: HTMLElement | null;
	content: ExplainContent;
	pinned: boolean;
	mode: "popover" | "sheet";
}

type ContentArg = ExplainContent | (() => ExplainContent);
const resolve = (c: ContentArg) => (typeof c === "function" ? c() : c);

/** Touch-primary device (phones, tablets)? Evaluated per interaction. */
export function isTouchPrimary(): boolean {
	try {
		return window.matchMedia("(pointer: coarse)").matches;
	} catch {
		return false;
	}
}

/** May a real mouse hover open a preview? True on desktops — `(hover: hover) and
 *  (pointer: fine)` — and on any device that isn't touch-primary (hybrids, kiosks and
 *  headless browsers report `pointer: none` but still drive a mouse). Callers also require
 *  `pointerType === "mouse"`, so a tap never triggers the hover path. */
export function canHover(): boolean {
	try {
		return window.matchMedia("(hover: hover) and (pointer: fine)").matches || !isTouchPrimary();
	} catch {
		return true;
	}
}

/** Should an activation open the bottom sheet? Touch / pen → yes; mouse → no; keyboard
 *  (no pointer) → only on touch-primary devices. */
export function wantsSheet(pointerType: string | undefined): boolean {
	if (pointerType === "touch" || pointerType === "pen") return true;
	if (pointerType === "mouse") return false;
	return isTouchPrimary();
}

/* ── Store (one active explanation) ─────────────────────────────────────── */

function createStore() {
	let active: Active | null = null;
	const listeners = new Set<() => void>();
	return {
		get: () => active,
		set: (next: Active | null) => {
			active = next;
			listeners.forEach((l) => l());
		},
		subscribe: (l: () => void) => {
			listeners.add(l);
			return () => listeners.delete(l);
		},
	};
}
type Store = ReturnType<typeof createStore>;

export interface ExplainController {
	/** Mouse entered a trigger. */
	hoverStart: (id: string, anchor: Measurable, content: ContentArg, trigger?: HTMLElement | null) => void;
	hoverEnd: (id: string) => void;
	/** Click / Enter / tap. `touch` opens the sheet instead of the popover. */
	activate: (
		id: string,
		anchor: Measurable,
		content: ContentArg,
		opts: { touch: boolean; trigger?: HTMLElement | null },
	) => void;
	/** Long-press accelerator. */
	openSheet: (id: string, anchor: Measurable, content: ContentArg, trigger?: HTMLElement | null) => void;
	close: () => void;
	store: Store;
}

const Ctx = createContext<ExplainController | null>(null);

export function useExplainController(): ExplainController {
	const c = useContext(Ctx);
	if (!c) throw new Error("useExplainController outside ExplainProvider");
	return c;
}

function useActiveId(store: Store): string | null {
	return useSyncExternalStore(store.subscribe, () => store.get()?.id ?? null);
}

/* ── Provider: the one popover + the one sheet ──────────────────────────── */

export function ExplainProvider({ children }: { children: React.ReactNode }) {
	const store = useMemo(createStore, []);
	const openTimer = useRef<number>();
	const closeTimer = useRef<number>();

	const clearTimers = () => {
		window.clearTimeout(openTimer.current);
		window.clearTimeout(closeTimer.current);
	};

	const controller = useMemo<ExplainController>(() => {
		const close = () => {
			clearTimers();
			store.set(null);
		};
		const scheduleClose = () => {
			window.clearTimeout(closeTimer.current);
			closeTimer.current = window.setTimeout(() => {
				const a = store.get();
				if (a && !a.pinned) store.set(null);
			}, CLOSE_GRACE);
		};
		return {
			store,
			close,
			hoverStart(id, anchor, content, trigger = null) {
				window.clearTimeout(closeTimer.current);
				const a = store.get();
				if (a?.pinned || a?.mode === "sheet") return;
				if (a && !a.pinned) {
					// A preview is already open: swap instantly (no flicker across a table).
					if (a.id !== id) store.set({ id, anchor, trigger, content: resolve(content), pinned: false, mode: "popover" });
					return;
				}
				window.clearTimeout(openTimer.current);
				openTimer.current = window.setTimeout(() => {
					const cur = store.get();
					if (cur?.pinned || cur?.mode === "sheet") return;
					store.set({ id, anchor, trigger, content: resolve(content), pinned: false, mode: "popover" });
				}, OPEN_DELAY);
			},
			hoverEnd(id) {
				window.clearTimeout(openTimer.current);
				const a = store.get();
				if (a && a.id === id && !a.pinned) scheduleClose();
			},
			activate(id, anchor, content, { touch, trigger = null }) {
				clearTimers();
				const a = store.get();
				if (touch) {
					store.set({ id, anchor, trigger, content: resolve(content), pinned: true, mode: "sheet" });
					return;
				}
				if (a && a.id === id && a.mode === "popover") {
					if (a.pinned) store.set(null);
					else store.set({ ...a, pinned: true });
					return;
				}
				store.set({ id, anchor, trigger, content: resolve(content), pinned: true, mode: "popover" });
			},
			openSheet(id, anchor, content, trigger = null) {
				clearTimers();
				store.set({ id, anchor, trigger, content: resolve(content), pinned: true, mode: "sheet" });
			},
		};
	}, [store]);

	// Hover leave from the popover itself.
	const onContentEnter = useCallback(() => window.clearTimeout(closeTimer.current), []);
	const onContentLeave = useCallback(
		(e: React.PointerEvent) => {
			if (e.pointerType !== "mouse") return;
			const a = store.get();
			if (a && !a.pinned) {
				window.clearTimeout(closeTimer.current);
				closeTimer.current = window.setTimeout(() => {
					const cur = store.get();
					if (cur && !cur.pinned) store.set(null);
				}, CLOSE_GRACE);
			}
		},
		[store],
	);

	useEffect(() => () => clearTimers(), []);

	return (
		<Ctx.Provider value={controller}>
			{children}
			<ExplainSurfaces store={store} close={controller.close} onEnter={onContentEnter} onLeave={onContentLeave} />
		</Ctx.Provider>
	);
}

function ExplainSurfaces({
	store,
	close,
	onEnter,
	onLeave,
}: {
	store: Store;
	close: () => void;
	onEnter: () => void;
	onLeave: (e: React.PointerEvent) => void;
}) {
	const active = useSyncExternalStore(store.subscribe, store.get);
	const anchorRef = useRef<Measurable>({ getBoundingClientRect: () => new DOMRect() });
	if (active) anchorRef.current = active.anchor;
	// Keep the last content while the closing animation / unmount runs.
	const lastContent = useRef<ExplainContent | null>(null);
	if (active) lastContent.current = active.content;

	const popoverOpen = active?.mode === "popover";
	const sheetOpen = active?.mode === "sheet";

	return (
		<>
			<Popover.Root
				open={popoverOpen}
				onOpenChange={(o) => {
					if (!o) close();
				}}
			>
				<Popover.Anchor virtualRef={anchorRef as React.RefObject<Measurable>} />
				<Popover.Portal>
					{popoverOpen && active && (
						<Popover.Content
							side="bottom"
							align="start"
							sideOffset={6}
							collisionPadding={12}
							avoidCollisions
							aria-label={active.content.title}
							className="explain-pop z-[70] w-[380px] max-w-[calc(100vw-24px)] rounded-xl bg-surface border border-border-md shadow-[0_14px_40px_rgba(40,30,15,.16)] outline-none overflow-y-auto"
							style={{ maxHeight: "min(560px, var(--radix-popover-content-available-height))" }}
							onOpenAutoFocus={(e) => {
								// A hover preview must not steal focus; a pinned one (click / keyboard) takes it.
								if (!active.pinned) e.preventDefault();
							}}
							onCloseAutoFocus={(e) => e.preventDefault()}
							onEscapeKeyDown={() => {
								// Esc returns focus to the number that opened it.
								const t = active.trigger;
								window.setTimeout(() => t?.focus({ preventScroll: true }), 0);
							}}
							onInteractOutside={(e) => {
								// A press on the active trigger toggles via its own click handler.
								const t = e.target as Node | null;
								if (t && active.trigger?.contains(t)) e.preventDefault();
							}}
							onPointerEnter={onEnter}
							onPointerLeave={onLeave}
						>
							<div className="p-4">
								<ExplainBody content={active.content} pinned={active.pinned} onClose={close} />
							</div>
						</Popover.Content>
					)}
				</Popover.Portal>
			</Popover.Root>

			<ExplainSheet
				open={sheetOpen}
				content={sheetOpen && active ? active.content : lastContent.current}
				trigger={active?.trigger ?? null}
				onClose={close}
			/>
		</>
	);
}

/* ── Bottom sheet (touch) ───────────────────────────────────────────────── */

function ExplainSheet({
	open,
	content,
	trigger,
	onClose,
}: {
	open: boolean;
	content: ExplainContent | null;
	trigger: HTMLElement | null;
	onClose: () => void;
}) {
	const [drag, setDrag] = useState(0);
	const start = useRef<number | null>(null);
	const triggerRef = useRef(trigger);
	if (trigger) triggerRef.current = trigger;

	useEffect(() => {
		if (open) setDrag(0);
	}, [open]);

	const onTouchStart = (e: React.TouchEvent) => {
		start.current = e.touches[0].clientY;
	};
	const onTouchMove = (e: React.TouchEvent) => {
		if (start.current == null) return;
		setDrag(Math.max(0, e.touches[0].clientY - start.current));
	};
	const onTouchEnd = () => {
		if (drag > 80) onClose();
		else setDrag(0);
		start.current = null;
	};

	return (
		<Dialog.Root
			open={open}
			onOpenChange={(o) => {
				if (!o) onClose();
			}}
		>
			<Dialog.Portal>
				<Dialog.Overlay className="explain-overlay fixed inset-0 z-[80] bg-[rgba(26,24,16,.38)]" />
				<Dialog.Content
					aria-describedby={undefined}
					className="explain-sheet fixed inset-x-0 bottom-0 z-[81] mx-auto w-full max-w-[560px] max-h-[86vh] flex flex-col rounded-t-[18px] bg-surface border-t border-border-md shadow-[0_-12px_40px_rgba(40,30,15,.18)] outline-none"
					style={{
						transform: drag ? `translateY(${drag}px)` : undefined,
						transition: start.current == null ? "transform .18s ease" : "none",
						paddingBottom: "env(safe-area-inset-bottom)",
					}}
					onOpenAutoFocus={(e) => e.preventDefault()}
					onCloseAutoFocus={(e) => {
						e.preventDefault();
						triggerRef.current?.focus({ preventScroll: true });
					}}
				>
					<div
						className="shrink-0 px-4 pt-2.5 pb-2 border-b border-border touch-none"
						onTouchStart={onTouchStart}
						onTouchMove={onTouchMove}
						onTouchEnd={onTouchEnd}
					>
						<div className="mx-auto mb-2 h-[5px] w-10 rounded-full bg-surface-3" aria-hidden="true" />
						<div className="flex items-start justify-between gap-3">
							<div className="min-w-0">
								{content?.context && (
									<div className="text-[10px] font-semibold tracking-[0.1em] uppercase text-text-3">
										{content.context}
									</div>
								)}
								<Dialog.Title className="text-[16px] font-semibold text-text leading-snug">
									{content?.title ?? "Breakdown"}
								</Dialog.Title>
							</div>
							<Dialog.Close
								className="shrink-0 w-11 h-11 -mr-2 -mt-1 rounded-full flex items-center justify-center text-text-2 hover:bg-surface-2"
								aria-label="Close"
							>
								<svg className="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
									<path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
								</svg>
							</Dialog.Close>
						</div>
					</div>
					<div className="overflow-y-auto overscroll-contain px-4 pt-3 pb-6">
						{content && <ExplainBody content={content} hideTitle />}
					</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

/* ── Trigger ────────────────────────────────────────────────────────────── */

export interface ExplainProps {
	content: ContentArg;
	children: React.ReactNode;
	className?: string;
	/** Override the accessible name (default: "title, value, sub, has breakdown"). */
	label?: string;
	/** Render the dotted underline on the children (default true). */
	underline?: boolean;
	/** Stretch to the parent's width (table cells, tiles). */
	block?: boolean;
	title?: string;
	/** Make the number a link (statement cells → their drill page, new tab): a mouse /
	 *  keyboard activation follows it, hover still previews; touch keeps tap → sheet (the
	 *  sheet carries the same link). */
	href?: string;
}

/** Wrap a number: hover (desktop) previews, click pins, tap / long-press opens the sheet. */
export function Explain({ content, children, className, label, underline = true, block = false, title, href }: ExplainProps) {
	const ctl = useExplainController();
	const id = useId();
	const activeId = useActiveId(ctl.store);
	const expanded = activeId === id;
	const ref = useRef<HTMLElement | null>(null);
	const lastPointer = useRef<string>("");
	const press = useRef<{ x: number; y: number; timer: number; fired: boolean } | null>(null);
	const contentRef = useRef(content);
	contentRef.current = content;
	const get = useCallback(() => resolve(contentRef.current), []);

	const aria = label ?? explainAriaLabel(resolve(content));

	const cancelPress = () => {
		if (press.current) window.clearTimeout(press.current.timer);
	};

	const props: React.HTMLAttributes<HTMLElement> & { "data-explain-trigger": string } = {
		className: cn("explain-trigger", block && "w-full justify-end", className),
		"aria-label": href ? `${aria}; opens the breakdown page in a new tab` : aria,
		"aria-expanded": expanded,
		title,
		"data-explain-trigger": "",
		onPointerEnter: (e) => {
			if (e.pointerType === "mouse" && canHover() && ref.current) ctl.hoverStart(id, ref.current, get, ref.current);
		},
		onPointerLeave: (e) => {
			if (e.pointerType === "mouse") ctl.hoverEnd(id);
		},
		onPointerDown: (e) => {
			lastPointer.current = e.pointerType;
		},
		onClick: (e) => {
			e.stopPropagation();
			const pt = lastPointer.current || (e.nativeEvent as PointerEvent).pointerType || "";
			const touch = wantsSheet(pt);
			lastPointer.current = "";
			if (href && !touch) {
				// Mouse / keyboard on a link: follow it (new tab) and drop the hover preview.
				ctl.close();
				return;
			}
			if (href) e.preventDefault();
			if (ref.current) ctl.activate(id, ref.current, get, { touch, trigger: ref.current });
		},
		onTouchStart: (e) => {
			const t = e.touches[0];
			cancelPress();
			press.current = {
				x: t.clientX,
				y: t.clientY,
				fired: false,
				timer: window.setTimeout(() => {
					if (!press.current || !ref.current) return;
					press.current.fired = true;
					try {
						navigator.vibrate?.(8);
					} catch {
						/* not supported */
					}
					ctl.openSheet(id, ref.current, get, ref.current);
				}, LONG_PRESS),
			};
		},
		onTouchMove: (e) => {
			const p = press.current;
			if (!p) return;
			const t = e.touches[0];
			if (Math.hypot(t.clientX - p.x, t.clientY - p.y) > MOVE_TOLERANCE) {
				cancelPress();
				press.current = null;
			}
		},
		onTouchEnd: (e) => {
			cancelPress();
			// The sheet is already open: swallow the click the browser would synthesise
			// (it would land on the sheet's overlay and close it).
			if (press.current?.fired) e.preventDefault();
			press.current = null;
		},
		onTouchCancel: () => {
			cancelPress();
			press.current = null;
		},
		// No callout on long-press; a link keeps its desktop context menu (open in new tab…).
		onContextMenu: (e) => {
			if (!href || press.current) e.preventDefault();
		},
	};
	const body = underline ? <span className="explain-u">{children}</span> : children;
	if (href) {
		return (
			<a {...props} ref={(el) => { ref.current = el; }} href={href} target="_blank" rel="noopener">
				{body}
			</a>
		);
	}
	return (
		<button {...props} ref={(el) => { ref.current = el; }} type="button" aria-haspopup="dialog">
			{body}
		</button>
	);
}

/* ── Body (same in popover and sheet) ───────────────────────────────────── */

export function ExplainBody({
	content: c,
	hideTitle = false,
	pinned,
	onClose,
}: {
	content: ExplainContent;
	hideTitle?: boolean;
	pinned?: boolean;
	onClose?: () => void;
}) {
	return (
		<div className="text-[12px] text-text">
			{!hideTitle && (
				<div className="flex items-start justify-between gap-3 mb-1">
					<div className="min-w-0">
						{c.context && (
							<div className="text-[9.5px] font-semibold tracking-[0.1em] uppercase text-text-3">{c.context}</div>
						)}
						<div className="text-[13.5px] font-semibold leading-snug">{c.title}</div>
					</div>
					{pinned && onClose && (
						<button
							type="button"
							onClick={onClose}
							className="shrink-0 -mr-1.5 -mt-1 w-7 h-7 rounded-full flex items-center justify-center text-text-3 hover:bg-surface-2 hover:text-text"
							aria-label="Close"
						>
							<svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
								<path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
							</svg>
						</button>
					)}
				</div>
			)}
			<div className="flex items-baseline gap-2 flex-wrap">
				<div className="text-[22px] font-semibold tabular-nums tracking-tight leading-tight">{c.value}</div>
				{c.valueSub && <div className="text-[11.5px] text-text-2 font-medium">{c.valueSub}</div>}
			</div>

			{(c.formula || c.formulaLive) && (
				<div className="mt-2.5 rounded-lg bg-surface-2/70 px-3 py-2">
					{c.formula && <div className="text-[11px] text-text-2 font-medium leading-snug">{c.formula}</div>}
					{c.formulaLive && (
						<div className="text-[11px] text-text tabular-nums mt-0.5 leading-snug break-words">{c.formulaLive}</div>
					)}
				</div>
			)}

			{c.components && c.components.length > 0 && (
				<RowsTable title={c.componentsTitle ?? "Built from"} rows={c.components} />
			)}
			{c.sources && c.sources.length > 0 && (
				<RowsTable title={c.sourcesTitle ?? "Ledgers"} rows={c.sources} showPct />
			)}

			{c.check && (
				<div
					className={cn(
						"mt-2 text-[11px] font-semibold tabular-nums px-2 py-1 rounded-md inline-flex",
						c.check.ok ? "bg-green-bg text-green" : "bg-amber-bg text-amber",
					)}
					role="status"
				>
					{c.check.text}
				</div>
			)}

			{c.notes && c.notes.length > 0 && (
				<ul className="mt-2 space-y-1">
					{c.notes.map((n, i) => (
						<li key={i} className="text-[10.5px] text-text-3 leading-snug">
							{n}
						</li>
					))}
				</ul>
			)}

			{c.links && c.links.length > 0 && (
				<div className="mt-3 pt-2.5 border-t border-border flex flex-wrap gap-1.5">
					{c.links.map((l) => (
						<a
							key={l.href + l.label}
							href={l.href}
							target="_blank"
							rel="noopener"
							className={cn(
								"inline-flex items-center gap-1 min-h-[32px] px-3 rounded-full text-[11.5px] font-semibold transition-colors",
								l.desk
									? "border border-border-md text-text-2 hover:bg-surface-2 hover:text-text"
									: "bg-green text-white hover:bg-green-mid",
							)}
						>
							{l.label} <span aria-hidden="true">↗</span>
							<span className="sr-only">(opens in a new tab)</span>
						</a>
					))}
				</div>
			)}
		</div>
	);
}

function RowsTable({ title, rows, showPct = false }: { title: string; rows: ExplainRow[]; showPct?: boolean }) {
	return (
		<div className="mt-3">
			<div className="text-[9.5px] font-semibold tracking-[0.1em] uppercase text-text-3 mb-1">{title}</div>
			<table className="w-full text-[11.5px] tabular-nums">
				<tbody>
					{rows.map((r, i) => (
						<tr key={i} className={cn("border-b border-border last:border-b-0", r.strong && "font-semibold")}>
							<td className="w-3 py-1 pr-1 text-text-3 align-top">{r.sign}</td>
							<td className={cn("py-1 pr-2 align-top break-words", r.muted && "text-text-2")}>
								{r.href ? (
									<a
										href={r.href}
										target="_blank"
										rel="noopener"
										className="hover:text-green hover:underline underline-offset-2"
									>
										{r.label} <span className="text-text-4" aria-hidden="true">↗</span>
									</a>
								) : (
									r.label
								)}
								{r.note && <span className="text-text-4 text-[10px] ml-1">{r.note}</span>}
								{r.deskHref && (
									<a
										href={r.deskHref}
										target="_blank"
										rel="noopener"
										className="ml-1 text-[10px] text-text-3 hover:text-green"
									>
										desk ↗
									</a>
								)}
							</td>
							<td className="py-1 text-right whitespace-nowrap align-top">
								{r.display ??
									(r.amount == null
										? "—"
										: formatINR(r.sign === "+" || r.sign === "−" ? Math.abs(r.amount) : r.amount))}
							</td>
							{showPct && (
								<td className="py-1 pl-2 w-[52px] text-right text-text-3 whitespace-nowrap align-top">
									{r.pct == null ? "" : formatPct(r.pct)}
								</td>
							)}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
