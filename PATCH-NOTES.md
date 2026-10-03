# Meridian Fork 补丁说明（Cd1s/meridian）

本仓库是上游 [rynfar/meridian](https://github.com/rynfar/meridian) 的自定义分支，主分支为 `ours/antigravity-gateway-patch`，基准上游分支为 `main`。
原则：不改官方 agy 的生成行为（模型名、思考等级、提示词都原样透传），只改分发层的兼容性和速度。

> **本仓库是公开的。** 这里只写代码和通用配置说明。账号邮箱、代理与出口 IP、服务器地址和别名、域名、Sub2API 账号编号、每个账号的增删记录等运营信息，一律记在私有运营仓库，不要提交到这里。

## 补丁清单

| 补丁 | 涉及文件 | 说明 |
| :--- | :--- | :--- |
| 放宽 agy 1.x 版本门禁 | `src/proxy/backends/antigravityRuntime.ts` | 兼容所有 `1.x` 官方 agy 版本（包含 `1.2.16` 及后续自动更新）；支持 `MERIDIAN_AGY_ANY_VERSION=1` 环境变量完全跳过版本检查 |
| CloudCode 桥接与资格修复 | `src/proxy/backends/antigravityBridge.ts`、`antigravityRuntime.ts` | 利用官方 CLI 的 `CLOUD_CODE_URL` 环境变量，将内部 Google 请求重定向到 Meridian loopback（复用 MCP 端口）。拦截并修补 `/v1internal:loadCodeAssist` 响应，注入 `currentTier` 并剔除 `ineligibleTiers`，绕过官方客户端对部分地区/账号的 eligibility 拦截；默认 upstream 切换为 `daily-cloudcode-pa.googleapis.com`，消除 Google 生产端点误报 429 限流；通过原生 Node.js SOCKS5/HTTP 隧道按账号隔离代理，其余 endpoint 原生流式透传 |
| 屏蔽 Claude 与指定模型 | `src/proxy/backends/antigravityRuntime.ts` | 默认屏蔽 Antigravity 运行时的 Claude 模型（`claude-*`，可通过 `MERIDIAN_AGY_BLOCK_CLAUDE=0` 放开），支持 `MERIDIAN_AGY_BLOCKED_MODELS` 自定义屏蔽列表；被屏蔽模型从 `/v1/models` 剔除，直接请求时返回 400 显式拦截，绝不向 Google 发送请求消耗额度 |
| 丢弃 `temperature` / `top_p` / `top_k` | `src/proxy/backends/antigravityProtocol.ts` | agy 没有采样参数；上游直接 400，Sub2API 的账号测试固定带 `temperature`，会全部失败。`betas` 仍按上游拒绝 |
| 思考等级选择同系列官方 slug | `src/proxy/backends/antigravityProtocol.ts`、`antigravityRuntime.ts` | Sub2API 把纯名（如 `gemini-3.8-flash`）映射到 `-low`；客户端带 `effort` / `reasoning_effort` 时换成同系列 `-<effort>`（上游 budget 适配也是这样换后缀）。账号没有该档（3.1 Pro 无 medium）时取最近档，优先更高。非 `gemini-*-low/medium/high` 模型仍按上游报错 |
| 授权检查可选缓存 `MERIDIAN_AGY_ACCOUNT_CHECK_TTL_MS` | `src/proxy/types.ts`、`antigravityRuntime.ts` | 上游每个请求都冷启动一次 `agy -p /config`（经代理约 5s）。设 TTL 后，成功结果在 TTL 内复用；失败不缓存。默认 0 = 上游行为，上限 600000 |
| 单进程多账号、单端口 `MERIDIAN_AGY_ACCOUNTS_DIR` | `bin/cli.ts`（`runAccountsCli`）、`src/proxy/backends/antigravityAccounts.ts` | 一个 Node 进程、一个端口（`MERIDIAN_PORT`）服务目录下所有账号，**按请求的 API key（`x-api-key` 或 `Authorization: Bearer`）选账号**；未知 key 返回 401，不带 key 的 `/health` 返回汇总。每个账号 `<dir>/<名>/env` 只需 `MERIDIAN_API_KEY`（≥16 位、不可重复）和代理变量，agy 登录在 `<dir>/<名>/.gemini`；每个账号仍是独立的后端实例、独立 HOME/代理/临时目录，官方 agy 的启动参数与工具调度（每账号一个 127.0.0.1 随机端口的 MCP 工具桥）不变。SIGHUP（`systemctl reload`）重读目录：新增的启动、删除的停止、env 改过的重启，其余不动；目录有错误时整次拒绝。启动失败的账号记录原因、每 60s 重试 |
| 账号级 agy 环境 `antigravity.env` | `src/proxy/types.ts`、`antigravityRuntime.ts` | 叠加到 agy 子进程环境（HOME、代理）；`MERIDIAN_API_KEY` 等敏感变量照旧剔除 |
| 每个服务独立 API key `apiKey` | `src/proxy/types.ts`、`src/proxy/auth.ts`、`antigravity.ts` | 未设置时仍读 `MERIDIAN_API_KEY`，与上游一致 |
| 共享 agy 进程池 `MERIDIAN_AGY_POOL_MAX` | `antigravityRuntime.ts`（`AgProcessPool`） | 所有账号合计的 agy 进程上限。满了时新请求可以回收任意账号的**空闲**热进程（上游原本只在本账号内回收）；都在忙就 429。单账号上限 `MAX_CONCURRENT` 照旧生效 |
| 待命 agy（预启动）`MERIDIAN_AGY_PREWARM_IDLE_MS` | `antigravityRuntime.ts`（`AgSpare`、`refillSpare`） | 每个账号最近 IDLE_MS 内有请求时，按最近一次新对话的形态（模型、思考等级、是否放开工具权限）提前启动 1 个官方 agy 等待输入；下一个同形态的新对话直接接管，省掉 4–5s 冷启动。依据实测：agy 不等输入就自己完成启动，`--print-timeout` 从收到消息才开始算，MCP `tools/list` 在收到消息后才调用，所以工具和放行规则可以在接管时再绑定（通过 MCP 别名）。不接管的情况：模型/等级/权限不同、带图片/文档/音视频、要求 JSON schema、续接已有对话、开了 `STATE_PATH`。待命进程超过 `PREWARM_MAX_AGE_MS`（默认 10 分钟）换新、账号空闲超时就退掉；它算进共享进程池，请求需要容量时最先让出。默认关闭 |
| 账号级临时目录 | `antigravityAccounts.ts`、`antigravityRuntime.ts` | 多账号模式下每个账号的 agy 用 `<账号>/.tmp` 当 `TMPDIR`，XDG 目录也指到账号内；Meridian 给 agy 建的工作目录也放在该 `TMPDIR` 下。之前所有账号共用 `/tmp`，agy 的功能开关缓存 `/tmp/unleash-repo-schema-v1-codeium-language-server.json` 是共享的 |
| 多账号管理面板 `MERIDIAN_ADMIN_PORT` | `antigravityAdmin.ts`、`antigravityAdminPage.ts`、`bin/cli.ts`、`scripts/agy-login.py` | 同进程内的管理接口 + 单页面（只绑 127.0.0.1，口令 `MERIDIAN_ADMIN_TOKEN` ≥16 位）。功能：账号列表（邮箱、端口、代理（密码打码）、状态/失败原因、请求统计、官方额度分组与重置时间、Sub2API 编号）、添加账号（校验代理并拒绝重复出口 IP → 分配名字/端口/key → 官方 agy 登录 → 自动启动 → 按模板账号自动在 Sub2API 建号）、重新登录、停用/启用（同步 Sub2API 状态）、测出口 IP、重载。额度结果缓存 5 分钟（每次读取都会让账号跑一次 `agy -p /usage`）。登录脚本给 agy 与运行时相同的隔离环境 |
| 探测结果后台刷新（同一开关） | `antigravityRuntime.ts` | 设了 TTL 时：授权检查和模型列表（`agy models`，上游固定 60s 缓存，此时取 max(60s, TTL)）过期后，若距上次成功不到 6×TTL，请求直接用旧结果，后台跑一次刷新；刷新失败立即清掉缓存，之后请求同步检查/被拦。超过 6×TTL 回到同步检查 |

## 线上配置（<生产机>）

2026-10-03 起：`meridian-accounts.service`（一个进程，10 个账号），代码在 `/opt/meridian/node_modules/@rynfar/meridian/dist-accounts/`。
旧的 `meridian@accN.service`（一账号一进程）已 stop + disable，单元文件和 `dist/` 保留用于回滚。
`meridian.service`（:3456，Claude/combined 后端，最早那次安装）与本 fork 无关，未动。

```
Environment="MERIDIAN_AGY_ACCOUNTS_DIR=/var/lib/meridian/instances"   # fork：单进程多账号
Environment="MERIDIAN_PORT=3451"                          # fork：全部账号共用这一个端口，API key 选账号（nginx <域名> 也指向它）
Environment="MERIDIAN_AGY_POOL_MAX=40"                    # fork：全部账号合计最多 40 个 agy（Sub2API 每号并发 5，共 50）
Environment="MERIDIAN_AGY_PREWARM_IDLE_MS=600000"         # fork：账号 10 分钟内有请求就保持 1 个待命 agy（约 225MB/个）
Environment="MERIDIAN_ADMIN_PORT=3450"                   # fork：管理面板，nginx <域名> → 127.0.0.1:3450（CF 代理 + <域名> 源站证书）
EnvironmentFile=/etc/meridian/admin.env                   # MERIDIAN_ADMIN_TOKEN（root 600）
Environment="MERIDIAN_SUB2API_BASE=http://127.0.0.1:8080/api/v1"
Environment="MERIDIAN_SUB2API_KEY_FILE=/etc/meridian/sub2api-admin-key"   # root:meridian 640
Environment="MERIDIAN_SUB2API_TEMPLATE_ID=<模板账号编号>"   # 必填：新账号照抄它的 model_mapping/分组/并发；不设则不同步 Sub2API
Environment="MERIDIAN_AGY_LOGIN_SCRIPT=/usr/local/bin/agy-login.py"   # 仓库 scripts/agy-login.py
Environment="MERIDIAN_AGY_ALLOW_TOOL_BRIDGE=1"
Environment="MERIDIAN_AGY_ACCOUNT_CHECK_TTL_MS=300000"   # fork 补丁：授权检查成功后 5 分钟内不重查
Environment="MERIDIAN_AGY_TOOL_TIMEOUT_MS=300000"        # 上游选项：已完成对话的热进程保留 5 分钟，续轮免冷启动
Environment="MERIDIAN_AGY_ADAPT_THINKING_BUDGETS=1"      # 上游选项：budget_tokens ≤2048 low / ≤8192 medium / 其余 high
Environment="MERIDIAN_AGY_MAX_CONCURRENT=8"              # 上游选项（默认 4）：热进程多了不必互相回收；每进程约 225MB
```

加账号：首选面板 https://<域名> （添加账号 → 填代理 → 登录 → 粘贴授权码；自动启动并在 Sub2API 建号，base_url `http://127.0.0.1:3451`，notes `Antigravity Meridian accN`）。手工方式见下方“手工添加账号”。

Sub2API：所有反重力账号 base_url 都是 `http://127.0.0.1:3451`，各自 api_key 不同；账号与目录的对应关系靠 notes `Antigravity Meridian accN`（Sub2API 不返回 api_key）。

各账号 `model_mapping`：纯名 → `-low`（如 `gemini-3.8-flash → gemini-3.8-flash-low`），带后缀的原样。

## 手工添加账号（给 agent 用）

生产机 `<生产机>`（`sshctl run <生产机> '...'`）。所有账号在 `meridian-accounts.service` 里，共用 `127.0.0.1:3451`，API key 选账号。
不要重启服务；不要输出 key 和代理密码；遇到出口 IP 重复、登录失败、403 Terms of Service、sshctl 连不上就停下报告。

**方式一（推荐）：调用面板接口**，与在 https://<域名> 里点按钮完全相同。接口只监听服务器本机，口令在 `/etc/meridian/admin.env`：

```bash
sshctl run <生产机> 'set -a; . /etc/meridian/admin.env; set +a; A="Authorization: Bearer $MERIDIAN_ADMIN_TOKEN"
curl -s -X POST -H "$A" -H "content-type: application/json" http://127.0.0.1:3450/api/accounts -d "{\"proxy\":\"socks5h://用户:密码@主机:端口\"}"'
# → {"name":"accN","exitIp":"..."}；出口 IP 与已有账号重复会返回 409
sshctl run <生产机> 'set -a; . /etc/meridian/admin.env; set +a; curl -s -X POST -H "Authorization: Bearer $MERIDIAN_ADMIN_TOKEN" http://127.0.0.1:3450/api/accounts/accN/login'
# → {"url":"https://accounts.google.com/..."}：原样发给用户，让用户登录后把 4/0... 授权码发回来（链接 10 分钟内有效）
sshctl run <生产机> 'set -a; . /etc/meridian/admin.env; set +a; curl -s -X POST -H "Authorization: Bearer $MERIDIAN_ADMIN_TOKEN" -H "content-type: application/json" http://127.0.0.1:3450/api/accounts/accN/code -d "{\"code\":\"4/0...\"}"'
# → {"email":"...","serving":true,"error":null,"sub2apiId":NNNN}：已自动启动，并在 Sub2API 建好账号
```

验证：`GET /api/accounts` 里该账号 `serving: true`；Sub2API `POST /admin/accounts/<sub2apiId>/test`，body `{"model_id":"gemini-3.8-flash"}`（必须带 model_id）返回 `test_complete` 且 success。
停用/启用：`POST /api/accounts/accN/disable`、`/enable`（同时改 Sub2API 状态）。

**方式二：纯手工**（面板不可用时）
1. 校验代理出口 IP 不与已有账号重复：`curl -s -m 15 -x "$P" https://api.ipify.org`，与各账号 env 里的 `ALL_PROXY` 逐个对比。
2. 建 `/var/lib/meridian/instances/accN/env`（目录 700、文件 600，属主 meridian）：`ALL_PROXY=$P`、`HTTP_PROXY=$P`、`HTTPS_PROXY=$P`、`MERIDIAN_API_KEY=cheek-meridian-accN-$(openssl rand -hex 12)`。不需要端口。
3. 登录：`nohup python3 /usr/local/bin/agy-login.py accN > /tmp/login_accN.log 2>&1 &`，从日志取 `AUTH_URL=` 发给用户；收到授权码后 `echo "4/0..." > /tmp/agy_accN.fifo`，日志出现 `TOKEN_SAVED=yes` 即成功。
4. `systemctl reload meridian-accounts`，日志出现 `reload: started=[accN]`。
5. Sub2API 新建账号：照抄模板账号的 `model_mapping`、`group_ids`、`concurrency`、`priority`；`platform: anthropic`、`type: apikey`、`name: 登录邮箱`、`notes: Antigravity Meridian accN`、`credentials: {base_url: http://127.0.0.1:3451, api_key: <accN 的 key>, model_mapping}`。建好后测试。

## 变更记录

### 2026-10-02 temperature 兼容 + 提速
- 原因：Sub2API 测试 acc1-4 报 `Antigravity does not support temperature`（之前手工改 dist 的热补丁被 3202811 的重新部署覆盖）；单请求约 12s。
- 实测拆解（经 socks 代理）：`agy -p /config` 4.7–5.6s（每请求）+ CLI 冷启动握手约 4.5s + 模型 2.5–4s。
- 验证：在远端编译机跑 antigravity 全部测试 175 pass / 0 fail，`tsc --noEmit` 0 错误，构建成功；
  线上 4 实例带 `temperature` 请求均 200；Sub2API `POST /admin/accounts/{<id>,<id>,<id>,<id>}/test`（`gemini-3.8-flash`）全部 success。
- 效果：新对话 12s → 6.5–7s；同一对话续轮 2.5–3.5s（`/health` 的 `reused` 计数增长）。偶发 40s+ 是 Google `streamGenerateContent` 自身慢。
- 回滚点：`/opt/meridian/backups/dist-20261002-021937`（temperature 补丁前）、`dist-20261002-022938` 与 `meridian@.service-20261002-022938`（提速前）；还原后 `systemctl daemon-reload && systemctl restart meridian@acc{1..4}`。
- 线上影响：4 个实例各重启，单次约 10s 不可用。
- 同日（02:41）：客户端 `gemini-3.8-flash` + effort high 报 `This agy model does not support the requested effort override`（Sub2API 映射成 -low 后与 high 冲突）。加入思考等级选 slug 补丁并开启 `ADAPT_THINKING_BUDGETS`。
  验证：176 pass / 0 fail；acc1 实测 -low+high→`gemini-3.8-flash-high`、-low+medium→medium、无等级→low、3.1-pro-low+medium→`gemini-3.1-pro-high`、budget 10000→high、OpenAI `reasoning_effort: high`→high（agy 日志 `Model ID` 确认）。
  回滚点：`/opt/meridian/backups/dist-20261002-024155`、`meridian@.service-20261002-024155`。
- 同日（02:54）：Sub2API 账号测试仍 11–19s。时间线：每次测试是新对话，且间隔 >60s，几乎每次都在请求路径上跑 `agy models`（3–4s），空闲 >5min 再加授权检查（6s）。加入后台刷新补丁，`MAX_CONCURRENT` 4→8。
  验证：177 pass / 0 fail。回滚点：`/opt/meridian/backups/dist-20261002-025407`、`meridian@.service-20261002-025407`。
- 同日：acc4（<账号邮箱>）重新登录成功，实测可用（此前判断的 ToS 封禁不成立），`meridian@acc4` 已 enable。

### 2026-10-03 单进程多账号
- 原因：账号增到 10 个，每个账号一个 Node 进程（约 95MB × 10）。排查时另发现 acc5–acc10 登录留下 10 个孤儿 `agy` TUI 进程（共 2.25GB，最久 9 小时），已清理；`login-acc.py` 改为以 meridian 身份运行、登录后结束 agy（备份在 `/opt/meridian/backups/login-acc.py-*`）。
- 验证：远端 antigravity + auth 测试 197 pass / 0 fail；全量 `bun run test` 4732 pass，1 fail 为 `fix-bun-exports` 集成测试，基线提交上同样失败，与本改动无关；`tsc` 0 错误，构建成功。
  线上：10 个端口全部 200；每个端口 agy 日志里的登录邮箱与 Sub2API 账号名一一对应；每个 agy 子进程的 HOME/ALL_PROXY 与该账号 env 一致；acc1 的 key 打 acc2 端口返回 401；Sub2API 测试 <id>/<id>/<id>/<id> success；`systemctl reload` 无变更时 started/stopped 均为空。
- 效果：Node 常驻内存约 950MB → 90MB；agy 总数有了全局上限（原来最坏 10×8=80 个，约 18GB → 40 个，约 9GB）。
- 第一次切换失败自动回滚（账号依次启动，每个 10s，30s 内只起了 2 个），改为并行启动后 13s 全部就绪。两次切换合计不可用约 50s。
- 回滚：`systemctl disable --now meridian-accounts && systemctl enable --now meridian@acc{1..10}`（旧单元与 `dist/` 未改）。

### 2026-10-03 待命 agy、账号临时目录隔离、管理面板
- 实测（acc1/acc5，官方 agy 1.2.14）：冷启动首字 6.4–7.3s；先启动、12s/35s/10min 后再发消息，首字 2.1–2.6s。agy 不等输入即完成启动（约 4.5s 输出 init），`--print-timeout` 从收到消息开始计时，MCP `tools/list` 在收到消息后才调用。
- 发现：所有账号的 agy 共用 `/tmp/unleash-repo-schema-v1-codeium-language-server.json`（功能开关定义缓存，无账号标识）。改为每账号 `TMPDIR`，旧共享文件已删。
- 第一次部署（02:49）自动回滚：acc9（<账号邮箱>）凭证失效，`agy -p /config` 返回 401 UNAUTHENTICATED（不是 ToS 封禁），检查脚本把它当成新版本故障。启动器随后加了失败账号记录与 60s 自动重试，检查改为排除已知失败账号。
- 验证：远端 antigravity + auth 测试 211 pass / 0 fail，`tsc` 0 错误，构建成功。线上：9 个账号服务（acc9 待重新登录）；acc6 连续 3 个新对话 9.9s → 2.4s → 1.9s（`prewarmed=2`）；Sub2API 测试 <id>/<id>/<id> success（有待命进程的 <id> 为 3.5s）；agy 子进程 `TMPDIR` 均在各自账号目录；面板公网 `/` 200，`/api/*` 无口令或错口令 401，接口返回不含 API key 与代理密码，额度显示官方分组（gemini-weekly / gemini-5h / 3p-weekly / 3p-5h）。
- 基础设施：Cloudflare `<域名>` A <源站IP>（已代理）；nginx `/etc/nginx/sites-available/<域名>.conf`；口令 `/etc/meridian/admin.env`。
- 回滚点：`/opt/meridian/backups/dist-accounts-20261003-025913`、`meridian-accounts.service-20261003-025913`（面板前）；`dist-accounts-20261003-024911`、`meridian-accounts.service-20261003-024911`（待命进程前）。服务重启 2 次，每次约 14s 不可用。

### 2026-10-03 单端口、按 API key 分账号
- 原因：每账号一个端口不便管理，Sub2API 要逐个配地址。改为一个端口、key 选账号；只改 Meridian 的 HTTP 入口，agy 的启动参数、环境、工具调度不变。
- 验证：远端 antigravity + auth 测试 213 pass / 0 fail（含真实 fixture 下两个账号同一监听按 key 分流、未知 key 401），`tsc` 0 错误，构建成功。线上：12 个账号全部在 3451 上按 key 返回 200，每个 key 对应的 agy 日志登录邮箱与 Sub2API 账号名一致；未知 key 401；旧的 11 个账号端口全部关闭；Sub2API 12 个账号 base_url 改为 3451 并回读核对 model_mapping，测试全部 success；面板列表 12 个账号、不含端口和 key。
- Sub2API 改动：PUT credentials {base_url, api_key（原 key 不变）, model_mapping（原值）} + notes。快照 `/opt/meridian/backups/sub2api-accounts-20261003-114342.jsonl`，迁移脚本 `/opt/meridian/backups/s2_migrate.py`。
- 回滚：`dist-accounts-20261003-114357`、`meridian-accounts.service-20261003-114357` 还原后重启，再按快照把各账号 base_url 改回原端口（env 文件里的 `MERIDIAN_PORT` 未删除，旧版本仍可用）。
- 线上影响：重启 19s；除 acc1 外其他账号在 Sub2API 更新前不可用，合计约 20s。

### 2026-10-03 独立审查后的修复
独立 agent 审查 `e3fa582..HEAD`：未发现跨账号串号（路由、MCP 别名、进程池回收、待命进程、状态与临时目录均按账号隔离）。修复的问题：
- 缺档回落（如账号无 3.1-pro-medium 改用 high）原本改写了请求本身，客户端下一轮仍带 medium，工具续接报 409、热进程无法复用。现在只用回落档启动 agy（`AntigravityRun.launch`），对话契约保留客户端的模型。
- 面板提交授权码：重复提交时阻塞写一个无人读取的 FIFO，会占住 libuv 线程，多次后整个进程的文件 IO 停顿。改为非阻塞打开、每次登录只收一次授权码。
- 待命进程被取走后、交接前出错时会泄漏；现在在失败路径上退掉。
- 任一账号 env 无效（key 缺失/过短/重复）会让整次同步失败、所有重载无效；现在只跳过并记录该账号。停止旧后端失败也不再中断同步。
- 重新登录时旧 token 存在会被误报成功；脚本改为比较 token 修改时间，FIFO 权限 666→600、读完即删。
- 账号检查失败（冷却中或检查缓存被清空）时不再继续补待命进程；agy 子进程环境剔除 `MERIDIAN_ADMIN_TOKEN`、`MERIDIAN_SUB2API_*`。
- 验证：远端 antigravity + auth 测试 215 pass / 0 fail（新增：回落后续轮复用、无效账号只跳过、关闭失败不阻断、授权码只收一次），`tsc` 0 错误；线上 12 个账号服务、Sub2API 抽测 4 个 success、agy 子进程无管理口令。回滚点 `dist-accounts-20261003-115808`、`agy-login.py-20261003-115808`。

## 同步上游


```bash
git fetch upstream
git checkout ours/antigravity-gateway-patch
git rebase upstream/main
```
