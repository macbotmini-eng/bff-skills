#!/usr/bin/env bun
/**
 * Primitive Stack Graph Reporter
 *
 * Maintains a human-readable overview of the MacBotMini primitive stack,
 * including skill ideas, PRD issues, implementation PRs, native GitHub
 * relationships, and drift warnings.
 *
 * Commands:
 *   report   Print Markdown report to stdout.
 *   check    Print JSON drift report to stdout.
 *   sync     Upsert the managed report comment on the overview issue.
 */

import { createHash } from "node:crypto";

type IssueState = "OPEN" | "CLOSED";
type PullRequestState = "OPEN" | "CLOSED" | "MERGED";

interface CliOptions {
  command: "report" | "check" | "sync";
  owner: string;
  repo: string;
  overviewIssue: number;
  token: string;
}

interface IssueNode {
  id: string;
  number: number;
  title: string;
  state: IssueState;
  url: string;
  body: string;
  parent?: SimpleNode | null;
  subIssues: { nodes: SimpleNode[] };
  blockedBy: { nodes: SimpleNode[] };
  comments: { nodes: CommentNode[] };
}

interface PullRequestNode {
  number: number;
  title: string;
  state: PullRequestState;
  isDraft: boolean;
  reviewDecision?: string | null;
  url: string;
  body: string;
  author: { login: string };
  closingIssuesReferences: { nodes: SimpleNode[] };
}

interface SimpleNode {
  id?: string;
  number: number;
  title: string;
  state?: string;
  url?: string;
}

interface CommentNode {
  databaseId: number;
  createdAt: string;
  updatedAt: string;
  url: string;
  author: { login: string };
  body: string;
}

interface GraphData {
  issues: Record<string, IssueNode>;
  prs: Record<string, PullRequestNode>;
  externalPrs: Record<string, PullRequestNode>;
}

interface DriftFinding {
  severity: "info" | "warning" | "critical";
  code: string;
  message: string;
}

const MARKER = "<!-- primitive-stack-graph-report -->";
const PROTECTED_OVERVIEW_BODY_SHA256 = "124713205d4c8b53270763fb02cae3ce94ecbb8629833b4361ef333a28ae36b6";

const ISSUE_NUMBERS = [558, 471, 473, 550, 553, 559, 560, 561, 562, 566, 570, 573, 576];
const PR_NUMBERS = [348, 495, 551, 556, 569, 571, 572, 574, 575, 577, 578];

const ACTIVE_IMPLEMENTATIONS: Array<{
  prd: number;
  pr: number;
  track: string;
  role: string;
  proof: string;
}> = [
  {
    prd: 550,
    pr: 551,
    track: "#471",
    role: "HODLMM selected-bin withdraw primitive",
    proof: "on-chain proof claimed in PR",
  },
  {
    prd: 553,
    pr: 556,
    track: "#471",
    role: "HODLMM selected-bin deposit primitive",
    proof: "on-chain proof claimed in PR",
  },
  {
    prd: 566,
    pr: 572,
    track: "#473",
    role: "Zest V2 Market borrow primitive",
    proof: "on-chain proof claimed in PR",
  },
  {
    prd: 573,
    pr: 574,
    track: "#473",
    role: "Zest V2 collateral deposit primitive",
    proof: "on-chain proof claimed in PR",
  },
  {
    prd: 576,
    pr: 577,
    track: "#473",
    role: "Bitflow swap aggregator primitive",
    proof: "one-route proof claimed; route matrix proof pending",
  },
  {
    prd: 561,
    pr: 578,
    track: "#473",
    role: "Forward leverage-cycle composed controller",
    proof: "draft; no proof claimed in current PR",
  },
];

const SUPERSEDED = [
  {
    item: "#560 — PRD: zest-borrow-asset primitive",
    replacement: "#566/#572",
    note: "older PRD now closed as superseded",
  },
  {
    item: "#570 — PRD-zest-borrow-asset-agnostic-primitive",
    replacement: "#566/#572",
    note: "helper-era PRD; closed",
  },
  {
    item: "#575 — bitflow-zest-sbtc-leverage-cycle",
    replacement: "#578",
    note: "closed historical draft",
  },
];

const COMPOSITION_GOALS = [
  {
    goal: "#559 — HODLMM-Zest yield router composition layer",
    track: "#471",
    role: "Composed yield router over accepted HODLMM entry/exit primitives",
    status: "pending implementation after primitive acceptance",
  },
  {
    goal: "#562 — sbtc-leverage-unwind-planner",
    track: "#473",
    role: "Unwind / close-position safety layer for the full loop",
    status: "no implementation PR in this graph yet",
  },
];

function parseArgs(argv: string[]): CliOptions {
  const args = argv.slice(2);
  const command = (args[0] || "report") as CliOptions["command"];
  if (!["report", "check", "sync"].includes(command)) {
    throw new Error(`Unknown command "${command}". Use report, check, or sync.`);
  }

  const parsed: Record<string, string> = {};
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      parsed[arg.slice(2)] = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : "true";
    }
  }

  const repoSlug = parsed.repo || process.env.GITHUB_REPOSITORY || "BitflowFinance/bff-skills";
  const [owner, repo] = repoSlug.split("/");
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
  if (!owner || !repo) throw new Error(`Invalid repo "${repoSlug}". Expected owner/repo.`);
  if (!token) throw new Error("GITHUB_TOKEN or GH_TOKEN is required.");

  return {
    command,
    owner,
    repo,
    overviewIssue: Number(parsed["overview-issue"] || "558"),
    token,
  };
}

async function githubGraphql<T>(opts: CliOptions, query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  const payload = await response.json();
  if (!response.ok || payload.errors) {
    throw new Error(`GitHub GraphQL failed: ${JSON.stringify(payload.errors || payload)}`);
  }
  return payload.data as T;
}

async function githubRest<T>(
  opts: CliOptions,
  path: string,
  init: RequestInit = {}
): Promise<{ response: Response; data: T }> {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${opts.token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const data = (await response.json()) as T;
  if (!response.ok) throw new Error(`GitHub REST failed (${response.status}): ${JSON.stringify(data)}`);
  return { response, data };
}

function issueAlias(number: number): string {
  return `i${number}`;
}

function prAlias(number: number): string {
  return `p${number}`;
}

async function loadGraph(opts: CliOptions): Promise<GraphData> {
  const issueFields = ISSUE_NUMBERS.map(
    (n) => `${issueAlias(n)}: issue(number:${n}) {
      id
      number
      title
      state
      url
      body
      parent { id number title state url }
      subIssues(first:50) { nodes { id number title state url } }
      blockedBy(first:50) { nodes { id number title state url } }
      comments(first:50) {
        nodes {
          databaseId
          createdAt
          updatedAt
          url
          author { login }
          body
        }
      }
    }`
  ).join("\n");

  const prFields = PR_NUMBERS.map(
    (n) => `${prAlias(n)}: pullRequest(number:${n}) {
      number
      title
      state
      isDraft
      reviewDecision
      url
      body
      author { login }
      closingIssuesReferences(first:20) { nodes { id number title state url } }
    }`
  ).join("\n");

  const query = `query($owner:String!, $repo:String!) {
    repository(owner:$owner, name:$repo) {
      ${issueFields}
      ${prFields}
    }
    aibtcdevSkills: repository(owner:"aibtcdev", name:"skills") {
      pr340: pullRequest(number:340) {
        number
        title
        state
        isDraft
        reviewDecision
        url
        body
        author { login }
        closingIssuesReferences(first:20) { nodes { id number title state url } }
      }
    }
  }`;

  const data = await githubGraphql<{
    repository: Record<string, IssueNode | PullRequestNode | null>;
    aibtcdevSkills: { pr340: PullRequestNode | null } | null;
  }>(opts, query, {
    owner: opts.owner,
    repo: opts.repo,
  });

  const issues: Record<string, IssueNode> = {};
  const prs: Record<string, PullRequestNode> = {};
  const externalPrs: Record<string, PullRequestNode> = {};
  for (const n of ISSUE_NUMBERS) {
    const issue = data.repository[issueAlias(n)] as IssueNode | null;
    if (issue) issues[String(n)] = issue;
  }
  for (const n of PR_NUMBERS) {
    const pr = data.repository[prAlias(n)] as PullRequestNode | null;
    if (pr) prs[String(n)] = pr;
  }
  if (data.aibtcdevSkills?.pr340) externalPrs["aibtcdev/skills#340"] = data.aibtcdevSkills.pr340;

  return { issues, prs, externalPrs };
}

function hasSubIssue(issue: IssueNode | undefined, subIssue: number): boolean {
  return Boolean(issue?.subIssues.nodes.some((node) => node.number === subIssue));
}

function blockedBy(issue: IssueNode | undefined, blocker: number): boolean {
  return Boolean(issue?.blockedBy.nodes.some((node) => node.number === blocker));
}

function closingIssue(pr: PullRequestNode | undefined, issue: number): boolean {
  return Boolean(pr?.closingIssuesReferences.nodes.some((node) => node.number === issue));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function classifyDrift(graph: GraphData): DriftFinding[] {
  const findings: DriftFinding[] = [];
  const i = graph.issues;
  const p = graph.prs;

  if (
    !i["558"]?.body.startsWith("> [!IMPORTANT]") &&
    !i["558"]?.body.startsWith("# Primitive Evaluation: #471 and #473")
  ) {
    findings.push({
      severity: "critical",
      code: "OVERVIEW_BODY_CHANGED",
      message: "#558 main body no longer starts with the protected snapshot heading.",
    });
  }

  if (i["558"] && sha256(i["558"].body) !== PROTECTED_OVERVIEW_BODY_SHA256) {
    findings.push({
      severity: "critical",
      code: "OVERVIEW_SNAPSHOT_HASH_CHANGED",
      message: "#558 main body differs from the restored protected snapshot. Add a follow-up comment instead of editing the body.",
    });
  }

  if (i["560"]?.state !== "CLOSED") {
    findings.push({
      severity: "warning",
      code: "OLD_BORROW_PRD_OPEN",
      message: "#560 should stay closed/superseded by #566/#572.",
    });
  }

  if (i["570"]?.state !== "CLOSED") {
    findings.push({
      severity: "warning",
      code: "HELPER_BORROW_PRD_OPEN",
      message: "#570 should stay closed/superseded by #566/#572.",
    });
  }

  if (!hasSubIssue(i["473"], 573)) {
    findings.push({ severity: "warning", code: "MISSING_SUBISSUE_573", message: "#473 should include #573 as a sub-issue." });
  }
  if (!hasSubIssue(i["473"], 576)) {
    findings.push({ severity: "warning", code: "MISSING_SUBISSUE_576", message: "#473 should include #576 as a sub-issue." });
  }
  if (!hasSubIssue(i["473"], 561)) {
    findings.push({ severity: "warning", code: "MISSING_SUBISSUE_561", message: "#473 should include #561 as a sub-issue." });
  }
  if (!hasSubIssue(i["473"], 562)) {
    findings.push({ severity: "warning", code: "MISSING_SUBISSUE_562", message: "#473 should include #562 as a sub-issue." });
  }

  if (!blockedBy(i["561"], 566)) {
    findings.push({ severity: "warning", code: "MISSING_BLOCKER_566", message: "#561 should be blocked by #566." });
  }
  if (!blockedBy(i["561"], 573)) {
    findings.push({ severity: "warning", code: "MISSING_BLOCKER_573", message: "#561 should be blocked by #573." });
  }
  if (!blockedBy(i["561"], 576)) {
    findings.push({ severity: "warning", code: "MISSING_BLOCKER_576", message: "#561 should be blocked by #576." });
  }
  if (!blockedBy(i["562"], 561)) {
    findings.push({ severity: "warning", code: "MISSING_BLOCKER_561", message: "#562 should be blocked by #561." });
  }

  for (const entry of ACTIVE_IMPLEMENTATIONS) {
    const pr = p[String(entry.pr)];
    if (!closingIssue(pr, entry.prd)) {
      findings.push({
        severity: "warning",
        code: `PR_${entry.pr}_NOT_LINKED`,
        message: `#${entry.pr} should close/implement #${entry.prd}.`,
      });
    }
  }

  if (!p["578"]?.isDraft) {
    findings.push({
      severity: "info",
      code: "CONTROLLER_NOT_DRAFT",
      message: "#578 is no longer a draft; verify primitive dependencies are accepted before treating it as ready.",
    });
  } else {
    findings.push({
      severity: "info",
      code: "CONTROLLER_IS_DRAFT",
      message: "#578 is still draft; treat it as forward-cycle work under active build/review, not accepted infrastructure.",
    });
  }

  const upstream340 = graph.externalPrs["aibtcdev/skills#340"];
  if (upstream340?.state === "OPEN" && upstream340.reviewDecision === "CHANGES_REQUESTED") {
    findings.push({
      severity: "info",
      code: "UPSTREAM_340_CHANGES_REQUESTED",
      message: "aibtcdev/skills#340 is still open with changes requested; #471 upstream HODLMM routing remains review-bound.",
    });
  }

  findings.push({
    severity: "info",
    code: "UNWIND_NOT_IMPLEMENTED",
    message: "#562 has no implementation PR in this graph yet; full-loop closure remains pending.",
  });

  return findings;
}

function prStatus(pr: PullRequestNode | undefined): string {
  if (!pr) return "missing";
  const bits = [pr.state.toLowerCase()];
  if (pr.isDraft) bits.push("draft");
  if (pr.reviewDecision) bits.push(pr.reviewDecision.toLowerCase().replace(/_/g, "-"));
  return bits.join(" / ");
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
}

function timelineSignal(comment: CommentNode): string {
  const body = comment.body;
  if (body.includes("corrected primitive-readiness update")) {
    return "Corrects the #471 reference model: BitflowFinance/bff-skills#340 is not on this path; aibtcdev/skills#340 is the upstream HODLMM-leg continuation; #495 is historical staging proof; #551/#556 are HODLMM primitive dependencies.";
  }
  if (body.includes("Operational read from @arc0btc")) {
    return "Reviewer context: #551/#556 dependency posture and the old Zest helper warning. The helper warning is now superseded for active borrow by the later #566/#572 V2 Market correction, but the dependency discipline still matters.";
  }
  if (body.includes("latest #473 dependency correction")) {
    return "Active #473 borrow correction: #566/#572 are the current Zest V2 Market borrow path; #570 and helper-era borrow-helper/pool-borrow paths are stale.";
  }
  if (body.includes("MacBotMini primitive dependency graph")) {
    return "Manual graph snapshot. This generated report should replace manual graph maintenance once the workflow lands.";
  }
  return "Timeline note that should be reviewed manually if it starts affecting graph structure.";
}

function timelineRows(issue: IssueNode | undefined): string {
  if (!issue) return "| missing | missing | missing |\n";
  const rows = issue.comments.nodes.map((comment) => {
    const firstHeading =
      comment.body
        .split("\n")
        .find((line) => line.startsWith("## "))
        ?.replace(/^##\s+/, "") || `Comment ${comment.databaseId}`;
    return `| [${comment.databaseId}](${comment.url}) | ${escapeTableCell(firstHeading)} | ${escapeTableCell(timelineSignal(comment))} |`;
  });
  return rows.length ? rows.join("\n") : "| none | none | none |";
}

function issueStatus(issue: IssueNode | undefined): string {
  if (!issue) return "missing";
  return issue.state.toLowerCase();
}

function mermaidClassForPr(pr: PullRequestNode | undefined): string {
  if (!pr) return "historical";
  if (pr.isDraft) return "draft";
  if (pr.state === "MERGED") return "accepted";
  if (pr.state === "CLOSED") return "historical";
  return "implementation";
}

function renderReport(graph: GraphData, findings: DriftFinding[]): string {
  const generatedAt = new Date().toISOString();
  const i = graph.issues;
  const p = graph.prs;
  const upstream340 = graph.externalPrs["aibtcdev/skills#340"];

  const blockers = findings.filter((finding) => finding.severity !== "info");
  const followUps = findings.filter((finding) => finding.severity === "info");
  const blockerText =
    blockers.length === 0
      ? "No structural blockers detected by the graph check."
      : blockers.map((finding) => `- **${finding.severity.toUpperCase()} ${finding.code}:** ${finding.message}`).join("\n");
  const followUpText =
    followUps.length === 0
      ? "No open follow-ups detected."
      : followUps.map((finding) => `- **${finding.code}:** ${finding.message}`).join("\n");

  const implementationRows = ACTIVE_IMPLEMENTATIONS.map((entry) => {
    const issue = i[String(entry.prd)];
    const pr = p[String(entry.pr)];
    return `| #${entry.prd} — ${issue?.title || "missing"} | ${entry.role} | #${entry.pr} — ${pr?.title || "missing"} | ${entry.track} | ${issueStatus(issue)} | ${prStatus(pr)} | ${entry.proof} |`;
  }).join("\n");
  const implementationClassLines = ACTIVE_IMPLEMENTATIONS.map((entry) => {
    const pr = p[String(entry.pr)];
    return `  class PR${entry.pr} ${mermaidClassForPr(pr)}`;
  }).join("\n");

  const supersededRows = SUPERSEDED.map((entry) => `| ${entry.item} | ${entry.replacement} | ${entry.note} |`).join("\n");
  const compositionRows = COMPOSITION_GOALS.map((entry) => `| ${entry.goal} | ${entry.track} | ${entry.role} | ${entry.status} |`).join("\n");

  return `${MARKER}
## Primitive Stack Graph Report

Generated: ${generatedAt}

This is the managed status report for #558. It is generated from GitHub issues, pull requests, native parent/sub-issue relationships, native blocked-by relationships, and linked PR references. It does not replace the protected #558 issue body.

### Current Picture

\`\`\`mermaid
flowchart TD
  IDX["#558 — Primitive Evaluation<br/>index / protected snapshot"]

  IDEA471["#471 — HODLMM-Zest Yield Maximizer<br/>skill idea / yield-router goal"]
  IDEA473["#473 — Leveraged sBTC via Zest + Bitflow<br/>skill idea / full-loop goal"]

  PRD550["#550 — bitflow-hodlmm-withdraw<br/>PRD issue"]
  PR551["#551 — bitflow-hodlmm-withdraw<br/>implementation PR / MacBotMini"]
  PRD553["#553 — bitflow-hodlmm-deposit<br/>PRD issue"]
  PR556["#556 — bitflow-hodlmm-deposit<br/>implementation PR / MacBotMini"]
  PRD559["#559 — Bitflow HODLMM-Zest yield loop<br/>router PRD"]
  EXT340["aibtcdev/skills#340 — sbtc-yield-maximizer HODLMM leg<br/>upstream continuation / review-bound"]

  PRD566["#566 — zest-borrow-asset-primitive<br/>PRD issue / active borrow"]
  PR572["#572 — zest-borrow-asset-primitive<br/>implementation PR / MacBotMini"]
  PRD573["#573 — zest-asset-deposit-primitive<br/>PRD issue"]
  PR574["#574 — zest-asset-deposit-primitive<br/>implementation PR / MacBotMini"]
  PRD576["#576 — bitflow-swap-aggregator<br/>PRD issue"]
  PR577["#577 — bitflow-swap-aggregator<br/>implementation PR / MacBotMini"]
  PRD561["#561 — Bitflow + Zest sBTC leverage cycle<br/>forward-cycle controller PRD"]
  PR578["#578 — bitflow-zest-sbtc-leverage-cycle<br/>composed controller PR / MacBotMini"]
  PRD562["#562 — sbtc-leverage-unwind-planner<br/>unwind / full-loop blocker"]

  OLD560["#560 — zest-borrow-asset primitive<br/>superseded older PRD"]
  OLD570["#570 — zest-borrow-asset-agnostic-primitive<br/>superseded helper-era PRD"]
  OLD575["#575 — bitflow-zest-sbtc-leverage-cycle<br/>closed historical draft"]
  OLD348["#348 — sbtc-leverage-looper<br/>prior attempt / warning case"]
  PR495["#495 — sBTC Yield Maximizer HODLMM leg<br/>staging proof / historical context"]

  IDX --> IDEA471
  IDX --> IDEA473

  IDEA471 --> PRD550 --> PR551 --> PRD559
  IDEA471 --> PRD553 --> PR556 --> PRD559
  IDEA471 --> PRD559
  IDEA471 -. upstream HODLMM leg .-> EXT340
  EXT340 -. rebalance primitive context .-> PRD559
  PR495 -. staging proof .-> IDEA471

  IDEA473 --> PRD566 --> PR572 --> PRD561
  IDEA473 --> PRD573 --> PR574 --> PRD561
  IDEA473 --> PRD576 --> PR577 --> PRD561
  IDEA473 --> PRD561 --> PR578 --> PRD562 --> IDEA473

  OLD560 -. superseded by .-> PRD566
  OLD570 -. superseded by .-> PRD566
  OLD575 -. superseded by .-> PR578
  OLD348 -. warning / not current path .-> PRD561
  OLD348 -. warning / no unwind proof .-> PRD562

  classDef index fill:#eef2ff,stroke:#3730a3,color:#111827,stroke-width:2px
  classDef idea fill:#fef3c7,stroke:#b45309,color:#111827,stroke-width:2px
  classDef prd fill:#dbeafe,stroke:#1d4ed8,color:#111827
  classDef accepted fill:#bbf7d0,stroke:#166534,color:#111827,stroke-width:2px
  classDef implementation fill:#dcfce7,stroke:#15803d,color:#111827
  classDef draft fill:#ffedd5,stroke:#c2410c,color:#111827,stroke-width:2px
  classDef composed fill:#e0f2fe,stroke:#0369a1,color:#111827,stroke-width:2px
  classDef blocker fill:#fee2e2,stroke:#b91c1c,color:#111827,stroke-width:2px
  classDef historical fill:#f3f4f6,stroke:#6b7280,color:#374151,stroke-dasharray: 5 5
  classDef external fill:#f5d0fe,stroke:#a21caf,color:#111827

  class IDX index
  class IDEA471,IDEA473 idea
  class PRD550,PRD553,PRD566,PRD573,PRD576 prd
${implementationClassLines}
  class PRD559,PRD561 composed
  class PRD562 blocker
  class OLD560,OLD570,OLD575,OLD348,PR495 historical
  class EXT340 external
\`\`\`

Legend: yellow = skill idea / goal, blue = PRD issue, dark green = merged implementation PR, light green = open implementation PR, orange = draft PR, cyan = composed controller/router PRD, red = unresolved full-loop blocker, gray = historical/superseded, purple = external upstream dependency.

### MacBotMini Core Stack

| PRD issue | Role | Implementation PR | Track | PRD state | PR state | Proof status |
|---|---|---|---|---|---|---|
${implementationRows}

### External / Timeline-Derived Dependencies

| Item | Role | Current status |
|---|---|---|
| [aibtcdev/skills#340](${upstream340?.url || "https://github.com/aibtcdev/skills/pull/340"}) — ${escapeTableCell(upstream340?.title || "sbtc-yield-maximizer HODLMM leg")} | Upstream #471 HODLMM routing continuation | ${prStatus(upstream340)} |

### Timeline Signals From #558

| Comment | Thread item | How it fits the graph |
|---|---|---|
${timelineRows(i["558"])}

### Superseded / Historical Nodes

| Item | Replacement | Note |
|---|---|---|
${supersededRows}

### Composition Goals Still Open

| Goal | Track | Role | Current status |
|---|---|---|---|
${compositionRows}

### Native GitHub Relationship Snapshot

- #473 sub-issues: ${i["473"]?.subIssues.nodes.map((node) => `#${node.number}`).join(", ") || "none"}
- #473 blocked by: ${i["473"]?.blockedBy.nodes.map((node) => `#${node.number}`).join(", ") || "none"}
- #561 blocked by: ${i["561"]?.blockedBy.nodes.map((node) => `#${node.number}`).join(", ") || "none"}
- #562 blocked by: ${i["562"]?.blockedBy.nodes.map((node) => `#${node.number}`).join(", ") || "none"}
- #566 parent: ${i["566"]?.parent ? `#${i["566"].parent.number} — ${i["566"].parent.title}` : "none"}

### Drift / Blocker Check

${blockerText}

### Open Follow-Ups

${followUpText}

### Next Work

1. Keep #566/#572 as the active Zest borrow primitive path.
2. Finish review/acceptance on #572, #574, and #577 before treating #578 as ready.
3. Build #562 as the unwind/close-position safety layer before calling #473 a full loop.
4. Keep #558 as the protected evaluation snapshot; update this managed comment for current status.
`;
}

async function syncReport(opts: CliOptions, report: string): Promise<void> {
  const commentsPath = `/repos/${opts.owner}/${opts.repo}/issues/${opts.overviewIssue}/comments?per_page=100`;
  const { data: comments } = await githubRest<Array<{ id: number; body: string; html_url: string }>>(opts, commentsPath);
  const existing = comments.find((comment) => comment.body.includes(MARKER));

  if (existing) {
    const { data } = await githubRest<{ html_url: string }>(opts, `/repos/${opts.owner}/${opts.repo}/issues/comments/${existing.id}`, {
      method: "PATCH",
      body: JSON.stringify({ body: report }),
    });
    console.error(`[primitive-stack-graph] Updated managed comment: ${data.html_url}`);
  } else {
    const { data } = await githubRest<{ html_url: string }>(opts, `/repos/${opts.owner}/${opts.repo}/issues/${opts.overviewIssue}/comments`, {
      method: "POST",
      body: JSON.stringify({ body: report }),
    });
    console.error(`[primitive-stack-graph] Created managed comment: ${data.html_url}`);
  }
}

async function main() {
  try {
    const opts = parseArgs(process.argv);
    const graph = await loadGraph(opts);
    const findings = classifyDrift(graph);

    if (opts.command === "check") {
      const criticalCount = findings.filter((finding) => finding.severity === "critical").length;
      console.log(JSON.stringify({ status: criticalCount ? "error" : "success", findings }, null, 2));
      if (criticalCount) process.exit(1);
      return;
    }

    const report = renderReport(graph, findings);
    if (opts.command === "report") {
      console.log(report);
      return;
    }

    await syncReport(opts, report);
    console.log(JSON.stringify({ status: "success", action: "sync", overviewIssue: opts.overviewIssue }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

await main();
