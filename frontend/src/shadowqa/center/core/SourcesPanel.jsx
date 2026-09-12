import { useState } from "react";
import { Badge, Button, Empty, Panel, clock } from "../ui";

const KIND_LABEL = {
  slack_message: "Slack", github_issue: "Issue", github_pr: "PR", github_review: "Review", github_comment: "Comment", github_check: "CI",
  github_commit: "Commit", conversation: "Chat", note: "Note",
};
const KIND_TONE = {
  slack_message: "text-[#e9a4ff] border-[#c96cf5]/40", github_pr: "text-[#8fd4ff] border-[#4fb3f0]/40", github_issue: "text-[#8fd4ff] border-[#4fb3f0]/40",
  github_commit: "text-[#98a3b3] border-white/10", github_check: "text-[#f2b95a] border-[#e8a33c]/40", conversation: "text-[#4fd6a3] border-[#2fbf8a]/40",
};

function Connector({ name, ok, detail, action, testid }) {
  return (
    <div className="flex items-start gap-3 rounded-md border border-white/[0.08] bg-[#12151a] px-3 py-2.5" data-testid={testid}>
      <span className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${ok ? "bg-[#2fbf8a] shadow-[0_0_8px_#2fbf8a]" : "bg-[#667081]"}`} />
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-semibold text-[#eef2f6]">{name}</div>
        <div className="text-[11px] text-[#98a3b3] leading-snug break-words">{detail}</div>
      </div>
      {action}
    </div>
  );
}

export function ImportDialog({ bridge, onDone, onClose }) {
  const [kind, setKind] = useState("chatgpt");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await bridge.importSource({ kind, title, text });
      onDone(res);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose} data-testid="cc-import-dialog">
      <div className="w-full max-w-2xl rounded-lg border border-white/[0.12] bg-[#0f1115] p-5 cc-rise" onClick={(e) => e.stopPropagation()}>
        <div className="text-[10px] uppercase tracking-[0.14em] text-[#667081] font-mono">ShadowQA Individual</div>
        <h3 className="text-[15px] font-semibold mt-0.5">Track a conversation</h3>
        <p className="text-[11.5px] text-[#98a3b3] mt-1">Paste the part of a ChatGPT, Claude, Claude Code or Codex session you want the project to remember. Only what you paste is read; Gemini extracts decisions and requirements with this source as provenance.</p>
        <div className="mt-4 grid sm:grid-cols-[160px_1fr] gap-2">
          <select value={kind} onChange={(e) => setKind(e.target.value)} className="rounded-md border border-white/[0.14] bg-[#12151a] px-3 py-2 text-[12.5px] text-[#eef2f6]" data-testid="cc-import-kind">
            <option value="chatgpt">ChatGPT conversation</option>
            <option value="claude">Claude conversation</option>
            <option value="claude_code">Claude Code session</option>
            <option value="codex">Codex session</option>
            <option value="note">Design note</option>
          </select>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title (optional)" className="rounded-md border border-white/[0.14] bg-[#12151a] px-3 py-2 text-[12.5px] text-[#eef2f6] placeholder:text-[#667081]" data-testid="cc-import-title" />
        </div>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={9} placeholder="User: …&#10;Assistant: …" className="mt-2 w-full rounded-md border border-white/[0.14] bg-[#12151a] px-3 py-2 text-[12px] font-mono text-[#eef2f6] placeholder:text-[#667081]" data-testid="cc-import-text" />
        {error && <p className="mt-2 text-[12px] text-[#ff8d7f]" data-testid="cc-import-error">{error}</p>}
        <div className="mt-3 flex justify-end gap-2">
          <Button onClick={onClose} testid="cc-import-cancel">Cancel</Button>
          <Button primary onClick={submit} disabled={busy || text.trim().length < 20} testid="cc-import-submit">{busy ? "Extracting with Gemini…" : "Track & extract"}</Button>
        </div>
      </div>
    </div>
  );
}

export function SourcesPanel({ bridge, overview, sources, say, refresh }) {
  const [importing, setImporting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const slack = overview?.connectors?.slack || {};
  const gh = overview?.connectors?.github || {};
  const sync = async () => {
    setSyncing(true);
    try {
      const r = await bridge.syncGithub();
      say(`GitHub synced — ${r.new} new source${r.new === 1 ? "" : "s"}.`);
      refresh();
    } catch (e) {
      say(e.message);
    } finally {
      setSyncing(false);
    }
  };
  const testSlack = () => bridge.testSlack().then((r) => say(`Posted to Slack channel ${r.channel}.`)).catch((e) => say(e.message));
  const channels = slack.channel_list || [];
  return (
    <Panel eyebrow="Sources" title="Where the context comes from" testid="cc-sources" action={<Button onClick={() => setImporting(true)} testid="cc-import-btn">+ Track a conversation</Button>}>
      <div className="grid gap-2 mb-4">
        <Connector
          name={`Slack · ${slack.team || "not connected"}`}
          ok={slack.connected}
          testid="cc-connector-slack"
          detail={slack.connected
            ? `Socket Mode live · ${channels.length ? channels.map((c) => `${c.name} (${c.count})`).join(", ") : "invite @ShadowQA to a channel and post — it starts reading there"} · ${slack.events} events${slack.error ? ` · ${slack.error}` : ""}`
            : slack.configured ? slack.error || "connecting…" : "SLACK_BOT_TOKEN / SLACK_APP_TOKEN not set"}
          action={slack.connected ? <Button onClick={testSlack} disabled={!slack.notify_channel} testid="cc-slack-test-btn">Post test</Button> : null}
        />
        <Connector
          name={`GitHub · ${gh.repo || "not configured"}`}
          ok={gh.configured && !gh.error}
          testid="cc-connector-github"
          detail={gh.configured ? `issues, PRs, reviews, comments, CI checks, commits · last sync ${gh.last_sync ? clock(gh.last_sync) : "pending"}${gh.error ? ` · ${gh.error}` : ""} · ${Object.entries(gh.counts || {}).map(([k, v]) => `${v} ${KIND_LABEL[k] || k}`).join(", ") || "nothing yet"}` : "SHADOWQA_GITHUB_WATCH_REPO / GITHUB_TOKEN not set"}
          action={gh.configured ? <Button onClick={sync} disabled={syncing || gh.syncing} testid="cc-github-sync-btn">{syncing || gh.syncing ? "Syncing…" : "Sync now"}</Button> : null}
        />
      </div>
      <div className="text-[10px] uppercase tracking-[0.12em] text-[#667081] font-mono mb-2">Recent sources · {overview?.sources ?? "—"} tracked{overview?.pending_sources ? ` · ${overview.pending_sources} awaiting extraction` : ""}</div>
      <div className="grid gap-1 max-h-64 overflow-auto pr-1" data-testid="cc-source-list">
        {(sources || []).slice(0, 25).map((s) => (
          <div key={s.id} className="grid grid-cols-[auto_1fr_auto] items-start gap-3 text-[11.5px] border-t border-white/[0.05] pt-1.5" data-testid={`cc-source-${s.id}`}>
            <Badge tone={KIND_TONE[s.kind] || "text-[#98a3b3] border-white/10"}>{KIND_LABEL[s.kind] || s.kind}</Badge>
            <div className="min-w-0">
              <div className="text-[#eef2f6] truncate">{s.title || s.text?.slice(0, 110)}</div>
              <div className="text-[#667081] font-mono text-[10.5px] truncate">{s.author}{s.channel_name ? ` · ${s.channel_name}` : ""} · {clock(s.ts)}{s.processed ? "" : " · extracting…"}</div>
            </div>
            {s.url ? <a href={s.url} target="_blank" rel="noreferrer" className="text-[#37b6d3] hover:underline font-mono text-[10.5px]" data-testid={`cc-source-link-${s.id}`}>open ↗</a> : <span />}
          </div>
        ))}
        {!(sources || []).length && <Empty>No sources yet — invite the Slack bot, sync GitHub, or track a conversation.</Empty>}
      </div>
      {importing && <ImportDialog bridge={bridge} onClose={() => setImporting(false)} onDone={(r) => { setImporting(false); say(`Tracked · Gemini extracted ${r.extracted?.items ?? 0} knowledge item${r.extracted?.items === 1 ? "" : "s"}.`); refresh(); }} />}
    </Panel>
  );
}
