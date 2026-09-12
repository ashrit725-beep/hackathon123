import { Panel } from "../ui";

export const MODES = [
  ["observe", "Observe", "capture, correlate, diagnose — never write"],
  ["approval", "Approval", "propose fixes and plans, a person approves"],
  ["auto-fix", "Auto-fix", "apply LOW-risk changes automatically, still verify"],
  ["full-auto", "Full-auto", "auto-fix + publish branches / PRs"],
];

export function PolicyPanel({ overview, onMode }) {
  const mode = overview?.mode;
  return (
    <Panel eyebrow="Developer control" title="Automation mode" testid="cc-policy">
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Automation mode">
        {MODES.map(([id, label, hint]) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={mode === id}
            onClick={() => onMode(id)}
            className={`text-left rounded-md border px-3 py-2.5 transition-[background-color,border-color] duration-150 ${mode === id ? "border-[#37b6d3] bg-[#37b6d3]/10" : "border-white/[0.1] bg-[#12151a] hover:border-white/25"}`}
            data-testid={`cc-mode-${id}`}
          >
            <div className={`text-[12.5px] font-semibold ${mode === id ? "text-[#eef2f6]" : "text-[#98a3b3]"}`}>{label}</div>
            <div className="text-[11px] text-[#667081] mt-0.5 leading-snug">{hint}</div>
          </button>
        ))}
      </div>
      <p className="mt-3 text-[11px] text-[#667081] leading-relaxed">
        One vocabulary for both layers: the mode governs runtime fixes (Live autonomy <span className="font-mono text-[#98a3b3]">{overview?.autonomy || "—"}</span>) and plan execution. Approvals happen here — Slack messages and emoji never authorize code changes.
      </p>
    </Panel>
  );
}
