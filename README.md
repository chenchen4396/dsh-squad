# dsh-squad

English | [简体中文](./README_CN.md)

Version `0.1.4` · MIT

**dsh-squad turns one DeepSeek Harness conversation into a workspace for a whole team of agents.**

You do not open a session per role. Enable a team inside a conversation you already have, and that conversation's own Agent becomes the **Leader** while every other member runs as its subagent — each with its own model, reasoning mode, permission preset, Skills, MCP servers and rule documents, all working in the same directory.

Nothing about your own workflow changes: you keep talking to that conversation. The Leader splits the work on a shared task board, members report progress and results back through the team mailbox, and the **团队** (Team) view shows every member's session side by side.

## Sixty seconds to a running team

1. **Configure models** in Harness (providers, credentials). dsh-squad reads the model catalog from the active Profile and never stores your API keys.
2. **Create assistants** under **Settings → dsh-squad**: 手动新建 builds one field by field, 开始对话 designs one through chat with the built-in 团队 Agent 小助手.
3. **Build a team** from **团队** at the bottom of the sidebar: add the assistants, mark exactly one as Leader, name it, and decide whether members may be addressed directly.
4. **Enable it** in any conversation, using the switch just left of the model selector (it reads 启用团队). The conversation's own Agent becomes the Leader and the rest start as its subagents.
5. **Hand the Leader a goal.** It creates tasks, wakes the owners, follows progress, and verifies the result.

## What a team is made of

| Piece | Meaning |
| --- | --- |
| **Assistant** | A reusable template: name, long-term instructions, provider/model, reasoning effort, Agent Preset, permission preset, allowed Skills, allowed MCP servers, and imported rule documents. Members inherit their assistant, so an edit reaches them on the next activation. |
| **Team** | A roster with exactly one Leader and any number of members. Each slot references an assistant, and the same assistant may be added more than once — every slot is an independent member. |
| **Conversation binding** | A team enabled in one Harness Session. The binding owns that conversation's member sessions, so the same team can run in several conversations at once without sharing context. |
| **Leader** | The conversation's own Agent. The only member that talks to you, and the one that answers for the team. |
| **Member** | A subagent of the Leader. It never appears in the sidebar and never reaches you directly. |
| **Task board** | The shared coordination state: title, description, status, one or several owners, optional Workspace-relative file scopes, and the result. |
| **Team mailbox** | Durable Leader↔member messages with a per-message delivery state, so nothing is lost while a member is busy. |
| **Workspace** | The conversation's working directory, shared by every member of the team. |

## Where it lives in the UI

- **团队 (sidebar footer)** — the management page, opened in the centre panel while the sidebar keeps rendering itself: team list, 组建团队, 管理助手, the selected team's task board, and dissolution.
- **团队 (conversation view)** — beside 对话 and 轨迹, scoped to the conversation you are looking at. This is the workbench.
- **Composer switch** — in the input tool row, immediately left of the model selector: enable a team here, see which one is enabled, toggle 替我审批, or disable it. Enabling requires an open session with a real working directory, and a conversation runs at most one team.
- **Settings → dsh-squad** — assistant templates, rule documents, and the Team Agent Assistant conversation.

## The workbench

- **Meeting room** — the conversation-level feed: dispatching, progress, results, and the cards waiting for an answer. Type `@` in the composer to mention members.
- **Member columns** — one per member: role, model, reasoning mode, live status, streaming output, Markdown, Think blocks and tool calls. Double-click a header to enlarge it; `↗` opens that member's own Session, where you can read its full record and message it directly.
- **Private composer** — single out one member and the composer addresses only that member; the Leader never sees the message.
- **Workspace panel** — browse files under 文件, refresh manually, and — when the directory is a Git repository — inspect 变更 and rendered diffs.

## Coordination protocol

Five tools are registered on the agents, and they are the whole protocol:

| Tool | Caller | Effect |
| --- | --- | --- |
| `team_get_task_board` | anyone | Read the shared task board. |
| `team_create_task` | Leader | Create a task; name one owner, or several with `ownerSlotIds` to start them in parallel. |
| `team_update_task` | the owners, and the Leader for any task | Report `running` / `blocked` / `completed` / `failed` with a result, or reassign. Member updates notify the Leader automatically. |
| `team_send_message` | anyone | Send a typed message (instruction, progress, result, question, warning) to another member and wake it. |
| `team_answer_member` | Leader | Settle a member's pending question or approval. |

Members share the Workspace but not the conversation history — that is what keeps roles and contexts isolated while they still edit the same files.

## Questions, approvals and 替我审批

A member cannot reach you. Its question or sandbox escalation is delivered to the Leader as a team message and answered with `team_answer_member`.

- A request beyond the Leader's own permission level is escalated to you instead: the interface opens the card immediately.
- If the Leader has not answered within 120 seconds, the card opens to you anyway, so a member is never stuck forever.
- **替我审批** (in the composer switch) takes you out of that loop: the Leader answers every question and approval of the conversation. A request beyond the Leader's own authority is refused on the spot rather than held for a card that will never open.

## Assistants and rule documents

An assistant carries everything a role needs: instructions, provider and model, reasoning effort, Agent Preset, permission preset, the Skills and MCP servers it may use, and the rule documents it loads. Skills and MCP servers come from what the active Profile already exposes through the standard Harness interfaces — dsh-squad selects among them and does not install, update or manage them.

Rule documents are imported whole rather than written entry by entry: a project `CLAUDE.md`, a design guide, or a folder of standards. Each file is stored verbatim under **Settings → dsh-squad → 规则文档** with the folder layout it was imported with, and an assistant selects which of them it loads.

## Team lifecycle

- **Create / clone:** 组建团队 writes a roster; 复制团队 reuses the same members and configuration with fresh sessions for everyone (tasks, history and runtime state are not copied).
- **Add / remove members:** removing a member stops and archives its sessions and tells the Leader; a member with unfinished tasks is not allowed to leave.
- **Change the Leader:** the successor's subagent session is released and the Leader role moves onto the conversation's own Agent.
- **Dissolve:** the team, its tasks and its messages are deleted permanently. Assistant templates and Workspace files stay.
- **Editing an assistant** affects every member using it; presets, Skills, MCP servers and rule documents apply when the member next activates.

## Install

Clone the repository and build it, then link that directory into the Harness profile you run:

```bash
git clone https://github.com/chenchen4396/dsh-squad.git
cd dsh-squad
npm install            # installs dependencies and builds lib/
dsh plugin --profile web add "$PWD"
```

`dsh plugin` forwards to `pnpm` inside the profile directory and adds the package to `dsh.profile.bundles` automatically. Start Harness and open the URL it prints (normally <http://127.0.0.1:3080/>), and restart Harness after installing, replacing or removing the plugin. Code changes need `npm run build` plus a Harness restart (a page reload is enough for client-only changes).

To remove it again:

```bash
dsh plugin --profile web remove @chenchen4396/dsh-squad
```

Requirements: Node.js `22.19.0+` or `24.0.0+`, DeepSeek Harness `0.1.5-rc.2` (the version this plugin is developed and verified against), and `pnpm` on `PATH` (`npm install -g pnpm`) — `dsh plugin` uses it to manage profile plugins. Nothing here modifies DeepSeek Harness source code.

## Plugin options

| Option | Default | Meaning |
| --- | --- | --- |
| `maxRequestBytes` | `131072` | Largest accepted request body for the team API (1 KiB – 1 MiB). |
| `sseHeartbeatMs` | `20000` | Event stream heartbeat interval (5 s – 120 s). |
| `runtimeConcurrency` | `4` | Team operations allowed to run at once (1 – 32). |
| `directMemberChatDefault` | `true` | Default of "members may be addressed directly" for new teams. |
| `assistantBuilderProvider` / `assistantBuilderModel` | *(empty)* | Model the Team Agent Assistant uses when the Profile has no stored preference. |
| `assistantBuilderAgentPresetId` / `assistantBuilderPermissionPresetId` | *(empty)* | Preset defaults for the Team Agent Assistant. |

## Known limits

- An assistant's permission preset is a member's default; reasoning modes come from the model's own capabilities and are never invented.
- MCP credentials stay in the Harness Profile — templates only store allowed server names.
- **变更** needs a Git workspace; a plain folder still supports file browsing.
- Removing a member or dissolving a team stops and archives the member sessions; the plugin does not delete the underlying session history from Harness storage.

## When something looks wrong

**`pnpm not found on PATH`** — `npm install -g pnpm`, confirm `pnpm --version`, install again.

**Port `3080` already in use** — another Harness process is running; stop it with `Ctrl+C` and start Harness again.

**A model or reasoning option is missing** — refresh the assistant catalog and check the model configuration; reasoning levels appear only when the provider reports that capability.

**An assistant cannot be deleted** — it is still referenced by a team member. Remove those members or dissolve the team first.

**No Git changes are shown** — the conversation's own directory must itself be a Git repository; a repository nested inside a non-Git directory is not treated as the Workspace repository.

**A member looks stuck** — it is waiting for an answer. Open the Team view: the request is either with the Leader (your card opens after 120 seconds), or, with 替我审批 on, it was refused because it exceeded the Leader's own permission level.

## Development

```bash
npm install                  # installs dependencies and runs the preparation build
npm run build                # bundles the server and client entries with tsdown
npm run typecheck            # TypeScript, no emit
npm test                     # Vitest, once
npm run guard:architecture   # enforces plugin boundaries
npm run check                # guard + typecheck + tests + production build
```

Verify UI changes in the browser against the `test` profile on port 3081 (`dsh --profile test --no-open --port 3081`), where this repository is linked in: `npm run build` plus a page reload is enough. Integrate with Harness only through its documented plugin APIs, Slots, services and semantic design tokens.

## Links

- [GitHub repository](https://github.com/chenchen4396/dsh-squad)
- [Issue tracker](https://github.com/chenchen4396/dsh-squad/issues)

## License

MIT
