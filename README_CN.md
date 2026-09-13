# dsh-squad

[English](./README.md) | 简体中文

版本 `0.1.4` · MIT

**dsh-squad 把 DeepSeek Harness 里的一个普通会话，变成一支 Agent 团队的工作空间。**

你不需要为每个角色各开一个会话：在已有的会话里启用团队，这个会话自身的 Agent 就成为 **Leader**，其余成员作为它的子 agent 运行——各自拥有独立的模型、思考模式、权限预设、Skills、MCP Servers 和规则文档，同时工作在同一份目录里。

你自己的使用方式不变：仍然只和这个会话对话。Leader 在共享任务板上拆解工作，成员通过团队信箱回报进度与结果，**团队**视图把所有成员的会话并排展示出来。

## 六十秒跑起一支团队

1. **配置模型**：先在 Harness 里配好 Provider 与凭据。dsh-squad 从当前 Profile 读取模型目录，自身不保存任何 API Key。
2. **创建助手**：打开 **设置 → dsh-squad**，**手动新建**逐项填写，或点**开始对话**让内置的**团队 Agent 小助手**通过聊天帮你设计。
3. **组建团队**：点侧栏底部的 **团队** → **组建团队**，加入助手、指定恰好一个 Leader、填写名称，并决定是否允许直接与成员对话。
4. **在会话里启用**：打开任意会话，用模型选择器左侧的开关启用（未启用时显示**启用团队**）。会话自身的 Agent 成为 Leader，其余成员作为它的子 agent 启动。
5. **把目标交给 Leader**：它会拆成任务、唤醒负责人、跟进进度并验收结果。

## 一支团队由什么组成

| 组成 | 含义 |
| --- | --- |
| **助手** | 可复用的模板：名称、长期提示词、Provider/模型、思考模式、Agent Preset、权限预设、允许的 Skills、允许的 MCP Servers，以及导入的规则文档。成员继承助手，修改后会在成员下次激活时生效。 |
| **团队** | 一份成员名册，恰好一个 Leader 加任意数量成员。每个位置引用一个助手，同一个助手可以加入多次，每个位置都是独立成员。 |
| **会话绑定** | 团队在某个 Harness 会话里的启用记录。绑定拥有该会话的成员 Session，因此同一支团队可以在多个会话里并发运行而互不共享上下文。 |
| **Leader** | 会话自身的 Agent。唯一与你对话的一方，也是代表团队作答的一方。 |
| **成员** | Leader 的子 agent。不会出现在侧栏，也不会直接联系你。 |
| **任务板** | 共享协作状态：标题、描述、状态、一个或多个负责人、可选的 Workspace 相对文件范围，以及结果。 |
| **团队信箱** | Leader 与成员之间持久化的消息，逐条带投递状态，成员忙碌时也不会丢。 |
| **Workspace** | 会话的工作目录，团队所有成员共用。 |

## 界面在哪里

- **团队（侧栏底部）**——管理页在中间面板打开，侧栏保持自身渲染：团队列表、组建团队、管理助手、所选团队的任务板、解散团队都在这里。
- **团队（会话内视图）**——和 **对话 / 轨迹** 并排，只作用于当前会话，这就是工作台。
- **输入框开关**——位于工具行内、模型选择器左侧：在这里启用团队、查看当前启用的团队、切换**替我审批**、或停用团队。启用要求会话已打开且有真实工作目录；一个会话同时只能启用一支团队。
- **设置 → dsh-squad**——助手模板、规则文档，以及团队 Agent 小助手会话。

## 工作台

- **会议室**：会话层面的信息流——派发、进度、结果，以及等待答复的卡片。输入 `@` 可以提及成员。
- **成员列**：每个成员一列，显示角色、模型、思考模式、实时状态，以及流式输出、Markdown、Think 块与工具调用。双击表头放大；`↗` 打开该成员自己的 Session，可查看完整记录并直接给它发消息。
- **独立输入框**：单独选中某个成员后，输入框只发给该成员，Leader 不会收到。
- **Workspace 面板**：在**文件**里浏览、手动刷新，并在目录是 Git 仓库时查看**变更**列表与渲染后的 Diff。

## 协作协议

全部协议就是注册在 Agent 上的五个工具：

| 工具 | 调用者 | 作用 |
| --- | --- | --- |
| `team_get_task_board` | 所有成员 | 读取共享任务板。 |
| `team_create_task` | Leader | 创建任务；用一个负责人，或用 `ownerSlotIds` 指定多个负责人并行开工。 |
| `team_update_task` | 任务负责人，Leader 可改任意任务 | 回报 `running` / `blocked` / `completed` / `failed` 及结果，或重新指派；成员更新会自动通知 Leader。 |
| `team_send_message` | 所有成员 | 给其他成员发送带类型的消息（指令、进度、结果、提问、警告）并唤醒对方。 |
| `team_answer_member` | Leader | 处理成员挂起的提问或审批。 |

成员共享 Workspace，但不共享对话历史——角色与上下文因此彼此隔离，同时又能改同一批文件。

## 提问、审批与「替我审批」

成员联系不到你。它的提问或提权请求会作为团队消息交给 Leader，由 Leader 用 `team_answer_member` 处理。

- 超出 Leader 自身权限级别的请求会转交给你，界面立刻打开这张卡片。
- 如果 Leader 在 120 秒内没有处理，卡片同样会开放给你，成员不会无限期卡住。
- **替我审批**（输入框开关里）会把你移出这个环节：该会话的所有提问和审批都由 Leader 答复；超出 Leader 自身权限的请求会被当场拒绝，而不是留一张永远不会打开的卡片。

## 助手与规则文档

一个助手包含角色的全部配置：长期提示词、Provider 与模型、思考模式、Agent Preset、权限预设、可用的 Skills 与 MCP Servers，以及要加载的规则文档。Skills 和 MCP Servers 来自当前 Profile 通过 Harness 标准接口已经暴露的资源——dsh-squad 只在其中挑选，不负责安装、更新与生命周期。

规则文档以整份文件导入，而不是逐条编写：项目里的 `CLAUDE.md`、一份设计规范，或一整个目录的约定。每份文件在 **设置 → dsh-squad → 规则文档** 中按导入时的目录结构原样保存，由助手选择加载哪些。

## 团队生命周期

- **组建 / 复制**：组建团队只写入名册；复制团队复用同样的成员与配置，并为所有成员创建全新 Session（不复制任务、历史与运行状态）。
- **增删成员**：移出成员会停止并归档它的 Session 并通知 Leader；仍有未完成任务的成员不允许移出。
- **更换 Leader**：释放继任者的子 agent Session，把 Leader 角色装回会话自身的 Agent。
- **解散团队**：团队、任务与消息被永久删除；助手模板与 Workspace 文件保留。
- **修改助手**：影响所有使用它的成员；权限预设、Skills、MCP Servers 与规则文档在成员下次激活时生效。

## 安装

克隆仓库并构建，然后把这个目录链接进你使用的 Harness Profile：

```bash
git clone https://github.com/chenchen4396/dsh-squad.git
cd dsh-squad
npm install            # 安装依赖并构建 lib/
dsh plugin --profile web add "$PWD"
```

`dsh plugin` 会把参数转发给 Profile 目录里的 `pnpm`，并自动把这个包加入 `dsh.profile.bundles`。启动 Harness 并打开它输出的地址（通常是 <http://127.0.0.1:3080/>）；安装、替换或卸载后都需要重启 Harness。改动源码后需要 `npm run build` 再重启 Harness（仅客户端改动刷新页面即可）。

卸载：

```bash
dsh plugin --profile web remove @chenchen4396/dsh-squad
```

运行要求：Node.js `22.19.0+` 或 `24.0.0+`、DeepSeek Harness `0.1.5-rc.2`（本插件的开发与验证版本）、`PATH` 中有 `pnpm`（`npm install -g pnpm`，`dsh plugin` 用它管理 Profile 插件）。以上操作都不会修改 DeepSeek Harness 源码。

## 插件配置

| 选项 | 默认值 | 含义 |
| --- | --- | --- |
| `maxRequestBytes` | `131072` | 团队接口接受的最大请求体（1 KiB – 1 MiB）。 |
| `sseHeartbeatMs` | `20000` | 事件流心跳间隔（5 s – 120 s）。 |
| `runtimeConcurrency` | `4` | 同时运行的团队操作数量（1 – 32）。 |
| `directMemberChatDefault` | `true` | 新建团队时「允许直接与成员对话」的默认值。 |
| `assistantBuilderProvider` / `assistantBuilderModel` | （空） | Profile 未保存偏好时，团队 Agent 小助手使用的模型。 |
| `assistantBuilderAgentPresetId` / `assistantBuilderPermissionPresetId` | （空） | 团队 Agent 小助手的预设默认值。 |

## 已知边界

- 助手的权限预设只是成员的默认值；思考模式来自模型自身能力，插件不会凭空提供模型未声明的选项。
- MCP 凭据保留在 Harness Profile 中，助手模板只保存允许的 Server 名称。
- **变更**需要 Git 工作区；普通目录仍支持文件浏览。
- 移除成员或解散团队会停止并归档成员 Session；插件不会删除 Harness 存储中的这些历史记录。

## 出问题时

**`pnpm not found on PATH`** —— 执行 `npm install -g pnpm`，确认 `pnpm --version` 后重新安装。

**端口 `3080` 被占用** —— 已有 Harness 进程在运行，用 `Ctrl+C` 停掉它再启动。

**缺少某个模型或思考模式** —— 刷新助手目录并检查模型配置；只有 Provider 声明了该能力，思考模式才会出现。

**助手删不掉** —— 它仍被某个团队成员引用，先移除这些成员或解散相关团队。

**看不到 Git 变更** —— 会话自身的工作目录必须就是 Git 仓库；嵌套在非 Git 目录里的仓库不会被当作工作区仓库。

**成员像是卡住了** —— 它在等待答复。打开团队视图：请求要么在 Leader 手里（120 秒后卡片会开放给你），要么在开启**替我审批**时因为超出 Leader 自身权限而被拒绝。

## 开发

```bash
npm install                  # 安装依赖并执行包准备构建
npm run build                # 用 tsdown 打包服务端与客户端入口
npm run typecheck            # TypeScript 类型检查，不产出文件
npm test                     # 运行一次 Vitest
npm run guard:architecture   # 校验插件边界
npm run check                # 架构守卫 + 类型检查 + 测试 + 生产构建
```

UI 改动请在浏览器里用 3081 端口的 `test` profile 验证（`dsh --profile test --no-open --port 3081`），该 profile 已链接本仓库，`npm run build` 后刷新页面即可。只通过 Harness 公开的插件 API、Slots、服务与语义化设计变量集成。

## 链接

- [GitHub 仓库](https://github.com/chenchen4396/dsh-squad)
- [问题反馈](https://github.com/chenchen4396/dsh-squad/issues)

## 许可证

MIT
