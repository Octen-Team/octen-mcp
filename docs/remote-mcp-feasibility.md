# Octen 远程 MCP Server（mcp.octen.ai）可行性设计文档

状态：**v1.1 —— 方向已定**（2026-08-14）· 作者：Engineering

> **2026-08-14 决策：按 Exa 的设计执行。** 即：
> 1. 双轨鉴权 —— Phase 1 header（同时接受 `x-api-key` 与 `Authorization: Bearer`），
>    Phase 2 自建 AS 接 dashboard 账号（§7 选项 a，Exa 路线）；
> 2. 鉴权卡在 `tools/call` 层，`initialize` / `tools/list` 免鉴权（事实 #12）；
> 3. 工具列表**静态**（§4.4 取 Phase 1 方案并定为终态，无权限的调用返回 403 信封错误）；
> 4. 独立子域名 `mcp.octen.ai`（对齐 `mcp.exa.ai`），AS 用 `auth.octen.ai`；
> 5. 本地 npm 包并行保留。
>
> Phase 0 PoC 随本决策即刻开工。

> 一句话结论：代码成本很小（MCP SDK 已内置全部传输层，现有 octen-mcp 逻辑约 90% 原样复用，
> PoC 2–3 人天），真正的成本在**运维责任**（7×24 服务、坏部署全量命中）和**鉴权分阶段**
> （API-key 透传覆盖不了 claude.ai 网页端，那里只认 OAuth）。建议做，但分两期，且**本地
> npm 包永久保留**。

---

## 1. 背景与动机

### 1.1 KIP 事件暴露的结构性问题

2026-08 KIP（重要投资机构）测试期间 27 次调用失败 12 次。根因排查（详见 0.4.0
CHANGELOG 与对 KIP 的回复文档）得出的**架构层教训**比三个具体 bug 更重要：

> 本地 stdio 分发把我们的可靠性绑在客户的机器和网络上，而我们对那两样都**没有可见性**。

具体表现：

- 失败发生在客户设备上的 Node 进程里，我们的服务端日志**查无记录**——双方无法对账；
- 修复（0.4.0）发布后仍要**等客户升级** npm 包才生效；
- 客户环境的变量（代理、Node 版本、bridge 转发）全部成为我们的故障面。

### 1.2 竞品基线：Exa

Exa 的官方首推是**远程托管** `https://mcp.exa.ai/mcp`，本地 npm 包为辅。KIP 反馈
"用 Exa 的 MCP 测试正常"——若他们用的是远程端点（待确认），则该对比实际上是
**两种部署架构的对比**，而非两个检索服务的对比。我们目前只有 stdio 本地包
（`src/index.ts` 仅挂载 `StdioServerTransport`），在这个对比里天然吃亏。

### 1.3 本次 0.4.0 打下的基础

0.4.0 的 HTTP 层（`src/http.ts`：调优的 undici dispatcher、按调用隔离的连接追踪、
重试/超时/`err.cause` 诊断、`x-request-id`、`x-azure-ref` 捕获）**与传输方式无关**，
远程模式下原样复用。工具定义、schema、结果格式化同样复用。与 stdio 耦合的只有
`index.ts` 中 2 行 transport 代码。

---

## 2. 目标与非目标

**目标**

1. 提供官方远程端点（暂定 `https://mcp.octen.ai/mcp`），Streamable HTTP 传输；
2. 与本地 npm 包**并行**存在，文档按场景给出推荐；
3. 失败发生在我们能看到日志的地方；版本由我们统一控制、灰度发布。

**非目标**

- ❌ 替代/废弃本地 stdio 包（合规客户与本机低延迟场景仍需要它，见 §5 场景 F）;
- ❌ Phase 1 不做 OAuth / 账号体系（见 §7 分期）;
- ❌ 不改变任何工具的名称、schema、行为——远程与本地必须是同一套工具的两种到达方式。

---

## 3. 事实基础（本次会话实测数据）

设计基于以下已验证事实，非估计：

| # | 事实 | 来源 |
|---|---|---|
| 1 | MCP SDK 1.29.0 已内置 `streamableHttp`（含**无状态模式** `sessionIdGenerator: undefined`）、`sse`、`express` 集成、`auth/` OAuth 骨架 | node_modules 实查 |
| 2 | handler 可经 `extra.requestInfo` / `extra.authInfo` 拿到每请求 HTTP 上下文（header 里的 key） | SDK d.ts 实查 |
| 3 | 现有代码读 `process.env.OCTEN_API_KEY` 共 5 处、handler 签名 6 个、`postJson` 调用点 5 处——"key 按请求传入"重构约 60 行 diff | grep 实测 |
| 4 | 本机 Desktop 会话 → 本地 stdio server 的 bridge 开销 **4ms**（996ms 总 − 992ms handler） | Desktop 真实端到端实测 |
| 5 | KIP 远程会话 → 绑定设备的中继串行化 **2–3 s/次**（到达时刻 2.20/2.73/3.10/2.23s） | KIP request_id 时间戳解码 |
| 6 | 冷握手 ~515ms；`api.octen.ai` 源站空闲关闭阈值 60–90s（AFD，无 Keep-Alive hint） | 实测 |
| 7 | claude.ai 网页/Cowork 自定义 connector **只支持 OAuth，不支持自定义 header**；Claude Code 与 Desktop 配置文件支持 header | anthropics/claude-ai-mcp#10、#112 |
| 8 | Anthropic Connector Directory 覆盖 Web/Desktop/移动/Claude Code/API，有公开提交流程 | support.claude.com FAQ |
| 9 | ChatGPT（Deep Research/connector）要求 MCP server 暴露名为 **`search` 与 `fetch`** 的工具 | OpenAI 官方 MCP 文档 + 社区 |
| 10 | `package.json` 已含 `mcpName: io.github.Octen-Team/octen-mcp`（官方 MCP registry 身份，registry 支持登记 remote 端点） | 仓库实查 |
| 11 | **Exa 是双轨鉴权**：header（`x-api-key`）之外，`mcp.exa.ai/.well-known/oauth-protected-resource` 返回 200，指向独立授权服务器 `auth.exa.ai`——完整 OAuth 2.1（authorization_code + refresh + PKCE S256 + DCR + revocation + JWKS，公共客户端），授权页是真实账号 "Sign in"，不是贴 key 的 shim | 对 Exa 端点的直接探测（2026-08-14） |
| 12 | Exa 的鉴权卡在 `tools/call` 层：**无 key 时 `initialize` 和 `tools/list` 都成功**——客户端可以先连上、看到工具，调用时才要求凭证 | 同上 |

---

## 4. 架构方案

### 4.1 形态：无状态 Streamable HTTP + key 透传

```
客户端(MCP client) ──HTTPS──▶ AFD (mcp.octen.ai) ──▶ mcp-server 容器 ──内网──▶ api.octen.ai 后端
                                                        │
                                                        └── 复用 0.4.0 的 src/http.ts（重试/超时/诊断）
```

- **无状态**（`sessionIdGenerator: undefined`）：六个工具全部无会话语义，每个
  `tools/call` 独立。无状态 → 水平扩展是纯加实例，无粘性会话、无跨实例状态。
- **鉴权 = 透传**：客户端在 header 带 key，mcp-server 原样转发给后端。后端**已有的**
  key 校验、配额、限流直接生效，mcp-server 自身零鉴权逻辑（Exa 同款模式）。
- **同时接受两种 header**：`x-api-key: <KEY>` 和 `Authorization: Bearer <KEY>`。
  依据：Codex 的 URL 型 MCP 只支持 Bearer token env（本机实查 `codex mcp list` 表头）；
  我们的 chat 端点本来就用 Bearer。一行判断，覆盖面翻倍。
- **响应模式**：启用 SSE 流式响应（SDK 默认），因为 `broad_search` 默认预算 120s，
  超过多数客户端的工具超时；长调用期间发 MCP progress notification 保活
  （spec 的 `resetTimeoutOnProgress`）。纯 JSON 模式（`enableJsonResponse`）留给
  健康检查等短路径。

### 4.2 部署位置带来的参数重估

mcp-server 与后端**同侧部署**（同 region 内网互通）后，0.4.0 里为"客户设备→跨洋边缘"
调的参数需要重估：

| 参数 | 0.4.0 本地包 | 远程 server 内网侧 |
|---|---|---|
| connectTimeout | 10s（跨洋） | 1–2s（内网） |
| keepAliveTimeout | 60s（AFD 90s 限制之下） | 按内网 LB 实测重定（方法沿用：空闲阶梯探测） |
| 重试 | 1 次 | 保留，内网 ECONNRESET 更罕见但语义不变 |
| search/broad_search 默认超时 | 30s/120s | 不变（这是给后端处理的预算，与链路无关） |

**客户端→mcp-server 一段**的超时不归我们管（客户端自己的 HTTP 栈），这正是远程模式
的优点之一：0.3.7 那类"undici 默认值"问题整类移出客户环境。

### 4.3 版本与灰度

远程端点没有"客户 pin 版本"一说——一次坏部署全量命中。这是 stdio 模式没有的新风险，
必须在上线前解决，而不是靠事后回滚：

- **金丝雀**：AFD 按权重分流 5% → 50% → 100%，观察错误率与 p95；
- **路径版本化预留**：`/mcp` 为 latest；若未来有破坏性协议变更，加 `/v1/mcp` 冻结旧行为
  （决策点，见 §11）;
- **健康检查** `/healthz`：不带 key 也能探活（只查进程与后端连通，不做真实检索）。

### 4.4 Beta 工具的按 key 动态列出（真实设计问题）

本地包用 `OCTEN_ENABLE_BETA_TOOLS` env 控制 `image_search`/`video_search` 是否出现在
`tools/list`。远程模式一个进程服务所有 key，env 开关失效。方案：

- **Phase 1（简单）**：`tools/list` 始终列全 6 个；无 Beta 权限的 key 调用时返回后端的
  403 信封错误（现有错误路径已能清晰呈现 `code=403 msg=...`）。缺点：模型可能选中一个
  必然失败的工具。
- **Phase 2（正确）**：`tools/list` 请求同样带 header ——按 key 查询 entitlement 动态过滤
  工具列表。需要后端提供一个轻量 entitlement 查询（或在 key 校验响应里带上），加
  60s 内存缓存。注意部分客户端会缓存工具列表，权限变更的生效有延迟，可接受。

---

## 5. 使用场景矩阵（按「MCP client 在哪里执行」划分）

这是全文档最重要的分析维度。远程 MCP 的收益不取决于工具本身，取决于 **MCP client
进程运行在哪**：

| 场景 | MCP client 位置 | 现状（stdio 包） | 远程模式 | 结论 |
|---|---|---|---|---|
| **A. 本机 Desktop/CLI 会话** | 用户本机 | bridge 4ms + 暖连接 ~270ms（0.4.0 实测），**很快** | 本机 → 我们边缘，一次公网 RTT，省掉本地 Node 但延迟未必更低 | 本地略优或打平；**继续推荐本地** |
| **B. claude.ai 网页/移动/Cowork 会话** | **Anthropic 基础设施** | 需经"远程会话→绑定设备"中继（KIP 实测 2–3s/次串行）+ 设备上的 Node + 设备网络 | Anthropic 机房 → 我们边缘，**用户设备与网络完全退出链路** | **远程碾压**。KIP 的 2–3s 串行、49s 首调、跨洋握手整链消失。⚠️ 但此场景要求 OAuth（事实 #7）→ Phase 2 |
| **C. Claude Code / Cursor / Codex 等本地 CLI** | 用户本机 | 需 Node + npx 冷启动（实测 ~4.7s，冷缓存更久） | `--transport http` 一行接入，免 Node/npx | 远程胜在**零安装**；延迟同 A |
| **D. CI / 无头 / 容器环境** | 流水线 runner | 每次跑 npx 拉包；受 runner 网络与 Node 版本影响 | 一个 URL + secret，无运行时依赖 | **远程明显优** |
| **E. 企业代理/受限网络** | 用户本机 | 0.4.0 已支持 HTTPS_PROXY，但需显式配置（Desktop 不继承系统 env，本机实测） | 客户端自身的 HTTP 栈处理代理（它们通常原生认系统代理） | 远程把"我们的代理坑"变成"客户端自己的代理支持"，**整类问题移交** |
| **F. 合规/审计敏感客户** | 用户本机 | key 与流量路径完全在客户掌控内，可审计 | 多一个我们的中间服务（尽管 key 本来就发给我们） | **本地是刚需**——保留 npm 包的核心理由；KIP 这类机构客户可能明确要求 |
| **G. 非 MCP 框架**（LangChain/LlamaIndex/Dify/直接 SDK） | — | 不走 MCP：`octen-py`、`langchain-octen` 等已覆盖 | 不受影响 | 边界说明：远程 MCP 与这些是并列渠道，四仓库 parity 约定不因此改变 |

**对 KIP 案例的诚实标注**：他们的报错 "device …not connected to the bridge" 表明是场景
B。Phase 1（仅 header 鉴权）**覆盖不到** claude.ai 网页的自定义 connector——所以如果
目标是彻底解决 KIP 这类场景，OAuth（Phase 2）不是锦上添花，是必要条件。Phase 1 期间
KIP 可用的改善是：绑定设备上的 Desktop/Claude Code 改配远程 URL，消掉设备上的
Node/npx/HTTP 栈，但 2–3s 的会话→设备中继仍在（那段在 Anthropic 侧，我们两种模式都
动不了）。

---

## 6. Agent 框架接入矩阵

| 客户端 | 传输 | 鉴权支持 | 配置样例 | Phase |
|---|---|---|---|---|
| **Claude Code** | Streamable HTTP | 自定义 header ✅ | `claude mcp add --transport http octen https://mcp.octen.ai/mcp --header "x-api-key: KEY"` | 1 |
| **Claude Desktop**（配置文件） | Streamable HTTP | 自定义 header ✅（事实 #7） | `{"url": "https://mcp.octen.ai/mcp", "headers": {"x-api-key": "KEY"}}` | 1 |
| **claude.ai 网页 / 移动 / Cowork**（connector UI） | Streamable HTTP | **仅 OAuth**（事实 #7，issues #10/#112 明确 header 不支持） | Settings → Connectors → Add custom connector（URL） | **2** |
| **Anthropic Connector Directory** 上架 | — | OAuth（目录面向全平台） | 官方提交流程（事实 #8） | 2 |
| **Cursor** | Streamable HTTP | header ✅ | `~/.cursor/mcp.json` url + headers；deeplink 一键安装可生成 | 1 |
| **Codex** | URL 型 MCP | **Bearer token env**（本机 `codex mcp list` 实查有专列） | `codex mcp add octen --url https://mcp.octen.ai/mcp --bearer-token-env-var OCTEN_API_KEY` | 1（需双 header 支持，§4.1） |
| **VS Code** | Streamable HTTP | header ✅ | `.vscode/mcp.json` `"type": "http"` | 1 |
| **Windsurf / Zed / Kiro / OpenCode / Warp / Gemini CLI** | 通用 url 配置 | 以 header 为主（逐个验证，见 §12） | 各自 mcp.json 变体 | 1 |
| **ChatGPT**（connector / Deep Research） | Streamable HTTP | OAuth 或免鉴权 | ⚠️ 硬性要求工具名为 **`search` + `fetch`**（事实 #9）。我们 `search` 天然匹配；`extract` 需别名 `fetch`（薄封装：单 URL、返回其 schema 要求的 `id/title/text/url` 形态） | 2.5（机会项，非必须） |
| **官方 MCP Registry** | — | — | 已有 `mcpName`（事实 #10），registry 登记 remote 端点，供支持 registry 发现的客户端使用 | 1（顺手） |

**文档义务**：README 的安装矩阵改为"远程优先展示、本地并列"（Exa 版式），
每客户端一行可复制配置。按 [[octen-api-tooling-parity]] 惯例，octen-skills 的
SKILL.md 与 docs.octen.ai 的 integrations 页同步更新。

---

## 7. 鉴权分期

### Phase 1：API-key 透传（header）

- 接受 `x-api-key` 与 `Authorization: Bearer` 两种形态；
- 无 key / 无效 key：返回 MCP error（复用现有信封错误路径，`code=401 msg=…` 已经清晰）；
- **key 不落日志**（0.4.0 的 debug 层已验证不打 key，远程侧沿用并在 CI 加断言）；
- 信任面分析：key 本来就是发给我们 API 的凭证，经过我们自己的 mcp-server **不增加
  新的暴露方**。与 Exa 的安全故事一致。

### Phase 2：OAuth 2.1（覆盖 claude.ai 网页 + 目录上架）

**先澄清一个常见误解：MCP server 本体不实现登录。** 按 MCP 授权规范（2025-06-18），
角色是分离的——MCP server 只做**资源服务器**（发布 Protected Resource Metadata、
校验 Bearer token），登录/授权/发 token 是**授权服务器（AS）**的事。"要不要写登录
逻辑"取决于 AS 从哪来，三个选项：

| 选项 | 登录逻辑 | 工作量 | 说明 |
|---|---|---|---|
| **(a) 自建 AS，接现有 dashboard 账号** | 复用 octen.ai dashboard 已有登录，**加** OAuth 端点（authorize/token/DCR/revoke/JWKS） | 2–4 周 | **Exa 的路线**（实测事实 #11：`auth.exa.ai`，授权页为真实 Sign in）。不是从零写登录，是给现有账号体系加发 token 能力 |
| **(b) 托管 AS**（Auth0 / WorkOS / Stytch 等的 MCP 现成方案） | 零登录代码 | 1–2 周 + 供应商费用 | 只写"身份 ↔ API key/配额"映射；引入外部依赖 |
| **(c) 贴 key 的 shim** | authorize 页 = 一个粘贴 API key 的表单，token 即包装后的 key | **数天** | 生态里有先例；无需账号体系。代价：体验差一档，目录审核是否接受待确认（事实 #8）。Exa 没走这条 |

- 无论哪个选项，MCP server 侧的改动相同且很小：发布 PRM well-known + 校验 token
  （SDK `auth/` 有现成中间件）；
- 收益不变：claude.ai 网页端"粘贴 URL / 目录一键添加"，用户不接触 key——
  KIP 这类非开发者场景（场景 B）的必要条件。

### Exa 双轨的启示（探测证据，事实 #11/#12）

用户文档里那段 `{"url": …, "headers": {"x-api-key": …}}` 只是 Exa 给**配置文件类
客户端**（Claude Code/Desktop/Cursor）的路径；探测证明他们**同时**运行完整 OAuth
覆盖 claude.ai 网页与目录。所以本方案的 Phase 1 = 精确对齐 Exa 的 header 轨，
Phase 2(a) = 对齐 Exa 的 OAuth 轨——他们的端点清单（authorize/token/register/
revoke/jwks + PRM）就是我们 Phase 2 的验收清单。

另一个值得照抄的设计（事实 #12）：**`initialize` 与 `tools/list` 不要求鉴权**，
凭证只在 `tools/call` 时校验。客户端能先连上、展示工具，配错 key 的失败发生在调用时
且带清晰错误——比握手即拒绝的排障体验好得多。副作用：工具列表对所有 key 相同，
§4.4 的"按 key 动态列出 Beta 工具"与此互斥，需二选一（倾向：跟随 Exa，静态列表 +
调用时 403 信封错误）。

---

## 8. 可观测性（直接继承 0.4.0 的工作，且补上最后一块）

远程模式下 0.4.0 加的所有仪表**自动变成服务端日志**，并解决两个 stdio 模式无解的问题：

1. **`x-request-id` 终于可查**——对 KIP 回复里那条 open item（"网关不记 inbound
   header"）在远程路径上直接闭环：mcp-server 是我们的进程，它自己记；
2. **工单不再依赖客户抓日志**：客户只需给时间窗 + key 前缀，我们有每次调用的
   received/returning、socket 状态、peer、耗时分段、后端 request_id、x-azure-ref 全链。

新增要求：

- 结构化日志（JSON line），字段沿用 0.4.0 debug 的命名，加 `key_prefix`（前 8 位）、
  `client_ua`（客户端 UA，定位是哪个 agent 框架）;
- 指标：QPS、错误率按 `cause.code` 分维度、p50/p95/p99 按工具分维度、上游（后端）
  耗时 vs 自身开销;
- 采样 trace 打通 AFD `x-azure-ref` ↔ mcp `x-request-id` ↔ 后端 request_id 三级关联。

---

## 9. 容量与成本

- 每请求 = 一次内网 API 转发 + JSON 重排，CPU/内存极轻。无状态 Node 服务，
  2 × 小规格实例起步（多 AZ），LB 后随 QPS 水平加;
- SSE 长连接持有：`broad_search` 120s 预算 × 并发数 = 同时挂起连接数上限，
  按后端现有 broad-search QPS 峰值 ×1.5 预留文件句柄与实例连接上限即可；
- 新增云成本量级：两个小实例 + AFD 一条路由，相对 api 后端本体可忽略；
- **真实成本是 on-call**：一个新的 7×24 面客服务进值班表、告警、runbook。

---

## 10. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 坏部署全量命中（stdio 模式没有的新风险） | 所有远程用户同时不可用 | 金丝雀分流 + 一键回滚 + 版本化路径预留（§4.3） |
| 单点故障/区域故障 | 同上 | 多 AZ 起步；工具 description 与错误文案里提示可切换本地包（自带降级路径是双模式并存的隐含收益） |
| 远程与 npm 包行为漂移 | 支持成本、文档失真 | 同一仓库同一构建产物，远程只是另一个入口文件；CI 对两种传输跑同一套 46 条测试 |
| key 滥用/无鉴权扫描打后端 | 后端限流被垃圾流量占用 | 边缘层先行拒绝无 key 请求；对 401 高频源 IP 限速 |
| 客户端工具超时 < broad_search 120s | 长调用被客户端掐断 | SSE + progress notification（§4.1）；文档标注各客户端超时调法 |
| OAuth 期限拉长导致 Phase 2 迟迟不上，claude.ai 场景长期缺位 | KIP 类场景 B 得不到根治 | 把 Phase 2 独立立项排期，不与 Phase 1 捆绑验收 |

---

## 11. 分阶段实施计划

| 阶段 | 内容 | 工作量 | 验收 |
|---|---|---|---|
| **Phase 0 — PoC** ✅ **已完成（2026-08-14，见 feat/remote-http-transport PR）** | `src/httpServer.ts`（无状态 streamableHttp + 双 header + call 层鉴权 + healthz）；`src/server.ts` 共享装配；key 按请求闭包传入（HTTP 明确**不**回退 env）。验收实况：56 条测试全绿（新增 10 条，含确定性的分段 body 租户隔离用例，已 mutation 验证）；真 key 打真 API 全链路通；Claude Code `--transport http` ✔ Connected | 实际 ~0.5 人天 | ✅ |
| **Phase 1 — 生产** | 容器化、AFD 路由 `mcp.octen.ai`、金丝雀、结构化日志/指标/告警、runbook、内网参数重测（§4.2）、README/docs/skills 三处安装矩阵更新、MCP registry 登记 remote | **1–2 周** | 灰度 100%；一次演练回滚；文档上线 |
| **Phase 2 — OAuth + 目录** | OAuth 2.1 全流程接 dashboard 账号体系、安全评审、Anthropic Connector Directory 提交、（可选）Beta 工具按 key 动态列出 | **2–4 周** | claude.ai 网页添加 connector 走通；目录提交受理 |
| **Phase 2.5 — 机会项** | ChatGPT `search`/`fetch` 兼容别名 | 1–2 天 | Deep Research 连通 demo |

Phase 0 可以立即开始，不依赖任何后端改动。

---

## 12. 待确认清单（写文档时明确标注的未知项）

1. **KIP 用的 Exa 是远程还是本地包**——决定竞品对比是否成立（已列入 KIP 回复的追问）；
2. Windsurf/Zed/Kiro/Gemini CLI 各自对自定义 header 的支持形态——Phase 1 文档矩阵前逐个真机验证；
3. Anthropic Connector Directory 的具体审核标准（OAuth 之外是否要求隐私政策/支持渠道页）——提交前读最新 FAQ；
4. 后端能否低成本暴露 key→entitlement 查询（§4.4 Phase 2 的依赖）；
5. 域名定 `mcp.octen.ai` 还是 `api.octen.ai/mcp`（AFD 路由与证书由谁管）；
6. 内网侧 keepAlive/connectTimeout 实测值（方法已有，部署后 1 小时内可测完）；
7. Codex 的 Bearer-only 是否确认（本机表头证据较强，官方文档核一遍）。

---

## 13. 决策建议

1. **批准 Phase 0 + Phase 1**：成本一至两周，消除"失败在客户机器上我们看不见"这个
   本次事件的结构性根因，并补齐与 Exa 的部署形态差距；
2. **Phase 2 独立立项**：它才是覆盖 claude.ai 网页（KIP 场景 B）的必要条件，
   不要让它隐没在 Phase 1 的验收里；
3. **本地 npm 包永久保留**并继续维护（场景 A 性能占优 + 场景 F 合规刚需），
   文档改为按场景推荐而非单一入口。
