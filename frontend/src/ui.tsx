import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  CircleCheck,
  CircleDashed,
  Clock3,
  EyeOff,
  LoaderCircle,
  ScanEye,
  SearchX,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  DECISION,
  EVIDENCE,
  EXTRACTION,
  POLICY_POSITION,
  RUN,
  SUBMISSION,
  TONE,
  human,
  kindLabel,
  KINDS,
  type Tone,
} from "./lib";
import type { Document } from "./types";

export const TONE_ICON: Record<Tone, LucideIcon> = {
  good: CircleCheck,
  warn: CircleDashed,
  neutral: SearchX,
  serious: EyeOff,
  critical: TriangleAlert,
  info: Clock3,
};

/** Status is never colour alone: every chip carries an icon and a label. */
export function Chip({
  tone,
  label,
  title,
  spin,
  icon,
}: {
  tone: Tone;
  label: string;
  title?: string;
  spin?: boolean;
  icon?: LucideIcon;
}) {
  const Icon = spin ? LoaderCircle : (icon ?? TONE_ICON[tone]);
  return (
    <span className={"chip " + TONE[tone].chip} title={title}>
      <Icon
        size={13}
        className={TONE[tone].dot + (spin ? " animate-spin" : "")}
        aria-hidden="true"
      />
      {label}
    </span>
  );
}
const lookup = (
  table: Record<string, { label: string; tone: Tone; plain?: string }>,
  value: string,
) =>
  table[value] ?? {
    label: human(value),
    tone: "neutral" as Tone,
    plain: undefined,
  };
export const EvidenceChip = ({ value }: { value: string }) => {
  const meta = lookup(EVIDENCE, value);
  return <Chip tone={meta.tone} label={meta.label} title={meta.plain} />;
};
export const SubmissionChip = ({ value }: { value: string }) => {
  const meta = lookup(SUBMISSION, value);
  return <Chip tone={meta.tone} label={meta.label} title={meta.plain} />;
};
export const PolicyChip = ({ value }: { value: string }) => {
  const meta = lookup(POLICY_POSITION, value);
  return <Chip tone={meta.tone} label={meta.label} title={meta.plain} />;
};
export const RunChip = ({ value }: { value: string }) => {
  const meta = lookup(RUN, value);
  return (
    <Chip tone={meta.tone} label={meta.label} spin={value === "running"} />
  );
};
/** Whether a document's text could be read, and whether any of it came from a scan or picture. */
export const ExtractionChip = ({
  document,
}: {
  document: Pick<Document, "extraction_status" | "ai_pages" | "unread_images">;
}) => {
  const meta = lookup(EXTRACTION, document.extraction_status);
  if (document.extraction_status === "unreadable")
    return <Chip tone={meta.tone} label={meta.label} />;
  if (document.unread_images)
    return (
      <Chip
        tone="warn"
        label="Picture unread"
        title="A picture in this file could not be read. Add the file again once the AI engine is available."
      />
    );
  if (document.ai_pages)
    return (
      <Chip
        tone="info"
        icon={ScanEye}
        label="Read by AI"
        title={
          document.ai_pages +
          (document.ai_pages === 1 ? " page was" : " pages were") +
          " read from a scan or picture by the AI model. Compare with the original."
        }
      />
    );
  return <Chip tone={meta.tone} label={meta.label} />;
};
export const DecisionChip = ({ value }: { value: string }) => {
  const meta = lookup(DECISION, value);
  return <Chip tone={meta.tone} label={meta.label} />;
};
export const KindChip = ({ value }: { value: string }) => (
  <span
    className={
      "chip border-transparent " + (KINDS[value]?.chip ?? KINDS.other.chip)
    }
  >
    {kindLabel(value)}
  </span>
);

export function Modal({
  title,
  subtitle,
  children,
  close,
  wide,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  close: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    ref.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    return () => previous?.focus();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      className={"dialog" + (wide ? " wide" : "")}
    >
      <div className="flex items-start justify-between gap-4 border-b border-line px-6 py-5">
        <div className="min-w-0">
          <h2 className="text-lg font-bold">{title}</h2>
          {subtitle && <p className="mt-1 text-sm text-ink-soft">{subtitle}</p>}
        </div>
        <button
          type="button"
          className="icon-btn -mr-2"
          aria-label="Close dialog"
          onClick={close}
        >
          <X size={20} />
        </button>
      </div>
      <div
        className="overflow-y-auto px-6 py-5"
        style={{ maxHeight: "calc(100vh - 9rem)" }}
      >
        {children}
      </div>
    </dialog>
  );
}

export function Confirm({
  title,
  body,
  action,
  onConfirm,
  close,
  busy,
}: {
  title: string;
  body: ReactNode;
  action: string;
  onConfirm: () => void;
  close: () => void;
  busy?: boolean;
}) {
  return (
    <Modal title={title} close={close}>
      <div className="text-sm leading-relaxed text-ink-soft">{body}</div>
      <div className="mt-6 flex justify-end gap-3">
        <button
          type="button"
          className="btn btn-soft"
          onClick={close}
          data-autofocus
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={busy}
          onClick={onConfirm}
        >
          {action}
        </button>
      </div>
    </Modal>
  );
}

export type Toast = { id: number; kind: "ok" | "error"; text: string };
export function Toasts({
  items,
  dismiss,
}: {
  items: Toast[];
  dismiss: (id: number) => void;
}) {
  return (
    <div className="pointer-events-none fixed inset-x-3 bottom-4 z-50 flex flex-col items-end gap-2 sm:inset-x-auto sm:right-5">
      {items.map((item) => (
        <div
          key={item.id}
          role={item.kind === "error" ? "alert" : "status"}
          className={
            "pointer-events-auto flex max-w-md animate-rise items-start gap-3 rounded-2xl border px-4 py-3 text-sm shadow-pop " +
            (item.kind === "error"
              ? "border-rose-200 bg-rose-50 text-rose-950"
              : "border-emerald-200 bg-white text-ink")
          }
        >
          {item.kind === "error" ? (
            <TriangleAlert
              size={18}
              className="mt-0.5 shrink-0 text-critical"
              aria-hidden="true"
            />
          ) : (
            <CircleCheck
              size={18}
              className="mt-0.5 shrink-0 text-good"
              aria-hidden="true"
            />
          )}
          <span className="min-w-0 flex-1 leading-snug">{item.text}</span>
          <button
            className="-m-1 rounded p-1 text-ink-soft hover:text-ink"
            aria-label="Dismiss message"
            onClick={() => dismiss(item.id)}
          >
            <X size={15} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function Empty({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      <span className="mb-4 grid size-14 place-items-center rounded-2xl bg-gradient-to-br from-violet-100 to-fuchsia-100 text-violet-700">
        <Icon size={26} aria-hidden="true" />
      </span>
      <h3 className="text-base font-bold">{title}</h3>
      <div className="mt-1.5 max-w-md text-sm leading-relaxed text-ink-soft">
        {children}
      </div>
    </div>
  );
}

export type Segment = { key: string; label: string; tone: Tone; value: number };

/** Part-to-whole as one horizontal stack. The legend doubles as the table view. */
export function StatusBar({
  segments,
  total,
  unit,
}: {
  segments: Segment[];
  total: number;
  unit: string;
}) {
  const [active, setActive] = useState<string | null>(null);
  const shown = segments.filter((segment) => segment.value > 0);
  return (
    <div>
      <div
        className="flex h-5 gap-0.5"
        role="img"
        aria-label={shown.map((s) => s.value + " " + s.label).join(", ")}
      >
        {shown.map((segment, index) => (
          <div
            key={segment.key}
            tabIndex={0}
            className={
              "relative min-w-3 outline-offset-2 transition-[filter,opacity] " +
              TONE[segment.tone].fill +
              (index === 0 ? " rounded-l" : "") +
              (index === shown.length - 1 ? " rounded-r" : "") +
              (active && active !== segment.key ? " opacity-45" : "") +
              (active === segment.key ? " brightness-110" : "")
            }
            style={{ flexGrow: segment.value, flexBasis: 0 }}
            onPointerEnter={() => setActive(segment.key)}
            onPointerLeave={() => setActive(null)}
            onFocus={() => setActive(segment.key)}
            onBlur={() => setActive(null)}
          >
            {active === segment.key && (
              <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 -translate-x-1/2 rounded-lg bg-ink px-2.5 py-1.5 text-xs whitespace-nowrap text-white shadow-lg">
                <strong className="font-bold">
                  {segment.value} of {total}
                </strong>{" "}
                <span className="opacity-80">
                  {segment.label.toLowerCase()}
                </span>
              </div>
            )}
          </div>
        ))}
        {!shown.length && <div className="flex-1 rounded bg-slate-100" />}
      </div>
      <ul className="mt-4 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        {segments.map((segment) => {
          const Icon = TONE_ICON[segment.tone];
          return (
            <li
              key={segment.key}
              className={
                "flex items-center gap-2 " + (segment.value ? "" : "opacity-45")
              }
              onPointerEnter={() => segment.value && setActive(segment.key)}
              onPointerLeave={() => setActive(null)}
            >
              <Icon
                size={15}
                className={TONE[segment.tone].dot}
                aria-hidden="true"
              />
              <span className="flex-1 text-ink-soft">{segment.label}</span>
              <strong className="font-semibold text-ink">
                {segment.value}
              </strong>
            </li>
          );
        })}
      </ul>
      <p className="sr-only">
        {total} {unit} in total.
      </p>
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <div
      className="flex items-center justify-center gap-3 px-6 py-12 text-sm text-ink-soft"
      role="status"
    >
      <LoaderCircle
        className="animate-spin text-violet-600"
        size={20}
        aria-hidden="true"
      />
      {label}
    </div>
  );
}
