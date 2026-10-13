# Meridian Fork 补丁说明（Cd1s/meridian）

本仓库是上游 [rynfar/meridian](https://github.com/rynfar/meridian) 的自定义分支，主分支为 `ours/antigravity-gateway-patch`，基准上游分支为 `main`。
原则：不改官方 agy 的生成行为（模型名、思考等级、提示词都原样透传），只改分发层的兼容性和速度。

> **本仓库是公开的。** 这里只写代码和通用配置说明。账号邮箱、代理与出口 IP、服务器地址和别名、域名、Sub2API 账号编号、每个账号的增删记录等运营信息，一律记在私有运营仓库，不要提交到这里。

## 补丁清单

| 补丁 | 涉及文件 | 说明 |
| :--- | :--- | :--- |
| 锁定 agy 版本（同上游） | `src/proxy/backends/antigravityRuntime.ts` | 和上游一样只接受经过验证的 agy 版本，现在是 `1.3.4`（2026-10-13 起；之前是放宽为任意 `1.x`，并可用 `MERIDIAN_AGY_ANY_VERSION=1` 跳过检查，这两项都已去掉）。升级 agy 前要先验证，再改这里 |
| CloudCode 桥接与资格修复 | `src/proxy/backends/antigravityBridge.ts`、`antigravityRuntime.ts` | **按账号严格 opt-in**：正常账号（未显式配置 `MERIDIAN_AGY_COMPAT_BRIDGE=1`）完全不注入 `CLOUD_CODE_URL`，保留 100% 原始未改写的 Google 原生响应；仅需要兼容的受限账号通过环境变量启用，拦截并修补 `/v1internal:loadCodeAssist` 响应（注入 `currentTier` 并剔除 `ineligibleTiers`），绕过官方客户端对部分地区/账号的 eligibility 拦截，默认 upstream 切换为 `daily-cloudcode-pa.googleapis.com` 消除误报 429；通过原生 Node.js SOCKS5/HTTP 隧道按账号隔离代理，其余 endpoint 原生流式透传 |
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
Environment="MERIDIAN_AGY_POOL_MAX=80"                    # fork：全部账号合计最多 80 个 agy（≥ Sub2API 每号并发 5 × 账号数，避免 Meridian 先 429；实测每个 agy 真实占用约 110MB）
Environment="MERIDIAN_AGY_PREWARM_IDLE_MS=600000"         # fork：账号 10 分钟内有请求就保持 1 个待命 agy（RSS 约 215MB，真实占用约 110MB/个）
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

### 2026-10-03 CloudCode 桥接与模型屏蔽的审查修复
审查 `070d333..fa895a9`（版本门禁、CloudCode 桥接、屏蔽 Claude、按账号 opt-in）后的修复：
- 屏蔽模型的检查原本在进程准入之后：请求 `claude-*` 在返回 400 之前就可能回收本账号或其他账号的空闲热进程、刷新待命进程活跃时间并跑授权检查。改为在 `create()` 最前面拒绝。
- 未开启桥接的账号，其 MCP 监听口也会把任意 `/v1*` 请求转发到 Google（本机任意进程可借账号代理与 token 中转）。现在只有开启桥接的账号才路由 `/v1*`。
- 桥接开关统一为 `agBridgeEnabled()`：`MERIDIAN_AGY_COMPAT_BRIDGE=1`（或兼容的 `MERIDIAN_AGY_ENABLE_CLOUD_CODE_BRIDGE=1`），去掉了无 `MERIDIAN_` 前缀的两个别名。
- `loadCodeAssist` 只改写 2xx 响应，401/403/429 原样返回给 agy（之前错误响应也会被注入 `currentTier`）；上游请求固定 `accept-encoding: identity`，加 60s 超时。
- SOCKS5 / HTTP CONNECT 握手改为累积读取完整应答（之前假设每个应答恰好一个 TCP 包，分包时会把残余字节喂给 TLS 导致握手失败）；IPv6 代理地址去掉方括号。
- 流式透传用 `pipeline`：上游中途断开时向 agy 传递错误，不再挂住；响应正常结束后不再销毁上游请求，保留 keep-alive 隧道（之前每个请求都重新做一次代理握手 + TLS）。剔除 hop-by-hop 头。
- 测试：原 `antigravity-bridge.test.ts` 在测试里复制了一份逻辑再断言自己，没有覆盖桥接代码。改为真实测试：逐字节分包的 SOCKS5（带认证、域名型应答）、HTTP CONNECT（含 407）、握手超时、gzip `loadCodeAssist` 改写、错误透传、流式透传与连接复用、上游不可达 502；另加“屏蔽模型不回收其他账号空闲进程”。
- 验证：远端 tsc 0 错误；antigravity + auth 227 pass / 0 fail；Node 下单独验证 SOCKS 分包握手、改写与流式透传；构建成功。

### 2026-10-03 登录脚本被终止时清理 agy
- 原因：面板在登录超时（10 分钟）、重复发起登录、停用账号时对 `agy-login.py` 发 SIGTERM。脚本没有处理信号就直接退出，而 agy TUI 在自己的会话里（`setsid`），于是成为孤儿（约 200MB/个），FIFO 也留在 `/tmp`。之前只在收到授权码后才结束 agy。
- 修复：SIGTERM/SIGINT/SIGHUP 转为退出，`finally` 中结束 agy 进程组并只删除本次创建的 FIFO（按 inode 判断，不误删同账号新一次登录的 FIFO）；agy 子进程设置 `PR_SET_PDEATHSIG`，脚本被 SIGKILL 时由内核结束 agy。
- 验证：一次性测试账号（不可用代理，不联网）下，SIGTERM、SIGKILL、提交错误授权码三种情况均无 agy 残留；同条件下旧脚本收到 SIGTERM 后 agy 残留且父进程为 1。

### 2026-10-03 agy 对话数据保留期 `scripts/agy-retention.py`
- 原因：agy 会把每次对话永久保存在账号的 `.gemini/antigravity-cli/` 下：`brain/<id>/`（完整对话记录）、`conversations/<id>.db*`、`annotations/<id>.pbtxt`、`presence/<id>.lock`，另有 `implicit/`、`log/`、`crashes/`。
- 脚本：一条对话的所有文件在 N 天（默认 7）内都没有更新时才整体删除；`implicit/`、`log/`、`crashes/` 按修改时间删除；不动 agy 自己的索引（`conversation_summaries.db`、`jetbox_summaries_proto.pb`）和登录 token。支持 `--dry-run`，`--days` 最小为 1。
- 部署方式：以服务用户运行的 systemd oneshot，加每日 timer（`Persistent=true`）。
- 验证：在一份账号数据副本上 `--days 1` 实测，删后剩余的对话都在窗口内有更新，索引与 token 保留。

### 2026-10-12 Antigravity 客户端去标识与脱敏（White-labeling）
- 原因：agy 底层模型在被提问运行环境时，容易从系统引导提示词（`You are serving a client through Meridian...`）、MCP 服务名（`meridian_client`）、工具名（`meridian_parallel`）、返回 envelope（`meridian_client_result`）及临时工作区目录名前缀（`meridian-agy-`）中识别出中继层存在，影响原生客户端体验。
- 改造：
  1. 系统提示词去标识：去掉 Meridian 引导语与归属描述，使用中性描述 `Follow the client's instructions...`、`client MCP`、`client attachment paths`。
  2. MCP 协议去特征：服务名改为 `client`，并行工具名改为 `batch_call`，返回 JSON 包装 Key 改为 `client_result` / `client_followup`。
  3. 工作区与安全策略：临时目录前缀改为 `workspace-`，工具调用 ID 改为标准 `toolu_<hex>`，策略检查原因信息去特征化。
  4. 兼容性：`policy.cjs` 同时允许 `client` 与 `meridian_client`，测试 fixture 兼容新旧结果 Key。
- 验证：320 个 antigravity 测试全部 pass（0 fail），`tsc --noEmit` 0 错误，打包构建成功。
- 2026-10-12 补正：上面的验证漏了 `antigravity-account-affinity.test.ts`，它仍断言 `toolu_agy_` 前缀而失败，会让每小时上游同步的检查步骤失败；已改为断言 `toolu_<32 hex>`。另把漏改的图片附件提示 `Meridian image attachment` 改为 `Image attachment`。仍带 Meridian 字样、模型可能看到的：原生会话目录里的 `.meridian-owner.json`，以及 `MERIDIAN_AGY_STATE_PATH` 所在目录名（图片附件绝对路径会出现在提示词里）。此改动仅本 fork，不提交上游。
- 升级注意：已保存的原生会话快照里，agy 历史记的是旧服务名 `meridian_client`，恢复后 MCP 配置只剩 `client`；policy 放行旧名，但如果模型照历史调用旧名，该次调用会失败。

### 2026-10-12 上游 PR #1340 / #1341 合并后的同步冲突
- 本 fork 的 #30 已包含 rynfar/meridian#1340（回放后不重复执行已完成的工具调用）和 rynfar/meridian#1341（`MERIDIAN_AGY_IDLE_CONVERSATION_MS`）。上游合并这两个 PR 后，同步会在 4 个文件冲突（已用 merge-tree 模拟确认）。
- 解决：`src/proxy/backends/antigravityRuntime.ts`、`src/proxy/types.ts`、`src/__tests__/fixtures/agy-replay-repeat-cli.cjs` 全部保留本 fork（HEAD）一侧，fork 一侧已是上游改动加上 fork 自己的字段与去标识改动；`docs/antigravity.md` 保留 HEAD 的 TURN_TIMEOUT / RUN_MAX 两行，TOOL_TIMEOUT 与 IDLE_CONVERSATION 两行两边已一致。

### 2026-10-12 发布 v1.80.0-cd1s.1 并部署到 Oracle-SGwest
- 发现：06:11 由 Mac mini 部署的去标识构建（provenance 仍写 63a56e7）不含 #30：线上没有 `agy_account_affinity`、`agy_replay_duplicate`，`MERIDIAN_AGY_IDLE_CONVERSATION_MS=1800000` 的 drop-in 也不生效。前一版 `dist-accounts.old-1073605` 是有的。
- 部署：`ac62621`（tag `v1.80.0-cd1s.1`，provenance `package-1.80.0-2-detached-ac626211`，非 dirty）的 `dist/` 打包为 `/opt/meridian/staging/dist-accounts-ac62621.tgz`（sha256 `ed3c0203…`），替换 `dist-accounts` 后重启，约 20s 恢复健康；依赖与 1.79.0 相同，`node_modules` 未动。
- 回滚点：`/opt/meridian/node_modules/@rynfar/meridian/dist-accounts.old-neutralize-20261012-103046`；打包备份 `/opt/meridian/backups/live-neutralize-before-ac62621-20261012-103020.tgz`（含 systemd 单元与 drop-in，sha256 `0e0f93f1…`），并已 `agent-backup put`。
- 验证：部署前后 `/health` 均为 20 个账号、失败 acc20/acc21/acc23（订阅配置检查失败，部署前已存在）；面板 3450 返回 200。实机 agy（`gemini-3.8-flash-medium`）：acc1 返回 `tool_use`（id 为 `toolu_<32 hex>`），用 acc2 的 key 发 tool_result，日志 `agy_account_affinity kind=tool selected=acc2 holder=acc1 status=200`，回答原样包含随机码，未出现 Meridian 字样。

### 2026-10-13 同步上游 1.81.0，发布 v1.81.0-cd1s.1 并部署
- 同步冲突：上游合并了 rynfar/meridian#1356（即本 fork 的 #1341，`MERIDIAN_AGY_IDLE_CONVERSATION_MS` 改为只在显式设置时校验）。5 个冲突文件的解决见 #34：fork 自有配置项全部保留，空闲保留的校验、文档行和测试用上游版本，`replayBudget.ts` 两边都保留。
- 自动同步的通知说“已开 issue”，但仓库里没有这个 issue：建 issue 这一步失败了，而且没有报错。
- 部署：`3c2ce8c`（tag `v1.81.0-cd1s.1`，provenance `package-1.81.0-1-detached-3c2ce8ca`，非 dirty），bundle sha256 `b1091404…`；运行时依赖未变（只有 devDependencies），`node_modules` 未动；约 18s 恢复健康。
- 回滚点：`dist-accounts.old-ac62621-20261013-111853`；打包备份 `/opt/meridian/backups/live-ac62621-before-3c2ce8c-20261013-111837.tgz`（sha256 `79d45931…`），并已 `agent-backup put`。
- 验证：部署前后 `/health` 均为 20 个账号、失败 acc20/acc21/acc23（部署前已存在）；面板 200。实机 agy（`gemini-3.8-flash-medium`）：acc1 `tool_use` → acc2 的 key 发 tool_result，`agy_account_affinity kind=tool holder=acc1 status=200`，回答包含随机码，未出现 Meridian 字样；部署后 3 分钟日志没有 error。

### 2026-10-13 回放保护不再把旧结果当新结果（#36，同 rynfar/meridian#1340 修订）
- 原因：上游维护者审 #1340 时指出，只看工具名和参数分不清是不是同一次操作。例如轮询状态读到 `running`，后台被替换、历史回放后，模型再读一次是正常轮询，但旧保护直接把记录的 `running` 当新结果返回。#30 的保护也有这个问题。
- 改动（#36）：回放后的新 run 在还没向客户端发出任何调用之前，第一个完全相同的调用不执行，也不返回旧内容，而是返回一条“未执行”提示（`is_error`），提示里写明已完成调用的 `tool_use_id`。模型再调用一次，就照常发给客户端执行。
- 测试脚本：`scripts/e2e-antigravity-replay-poll.mjs`，和上游 PR 是同一套。本 fork 的 MCP 结果字段叫 `client_result`，脚本两种字段名都认。
- 实测：
  - SG（Linux，`gemini-3.8-flash-medium`）：旧保护 3/3 次把 `running` 当新结果返回；新版 3/3 次先返回提示，模型再读，读到 `done`。
  - MacBook Air（macOS arm64）：官方 agy 1.2.7（可执行文件 sha256 `8c01ef82…`）、Pi 1.1.0（`dist/bundle/cli.js` sha256 `e79626f2…`）、`gemini-3.8-flash-low`，使用 Meridian Pi 插件并先做 fixture 预检。四组结果：上游 main PASS，旧保护 FAIL（回放后收到 `running`），新版 PASS，打包安装版 PASS。本 fork 版本 `e87104b1` 也 PASS（提示 → 再读 → `done`）。证据在 rynfar/meridian#1340 的 `docs/maintenance/evidence/1340-replay-notice-20261013.md`。
- MacBook Air 环境说明：
  - agy 登录信息存在钥匙串里，SSH 会话读不到。测试改为用 `open` 让桌面会话里的“终端”运行 `.command` 脚本。
  - 测试用的 agy 1.2.7 放在 `~/meridian-e2e/owned/agy-1.2.7/`，并设置 `AGY_CLI_DISABLE_AUTO_UPDATE=true`；全局的 `~/.local/bin/agy` 是 1.3.3，保持不动。
- 发布与部署：
  - `v1.81.0-cd1s.2`（`09f6b64`，provenance `package-1.81.0-1-detached-09f6b64c`，非 dirty），bundle sha256 `2dd3539a…`。
  - 部署到 Oracle-SGwest 后约 18s 恢复健康。产品代码和之前在跑的 `980e4d6`（#36）相同。
- 回滚点：
  - `dist-accounts.old-980e4d6-20261013-130347`；
  - 打包备份 `/opt/meridian/backups/live-980e4d6-before-09f6b64-20261013-130338.tgz`，并已 `agent-backup put`（sha256 `758f0d2d…`）。
- 验证：
  - `/health` 部署前后都是 20 个账号，失败 acc20/acc21/acc23（部署前已存在）；面板 200。
  - 跨账号：acc1 发起 `tool_use`，acc2 的 key 发 tool_result，日志 `agy_account_affinity holder=acc1 status=200`，回答包含随机码。
  - 轮询回放 3/3：提示 → 模型再读 → `done`。
  - 部署后 20 分钟日志 0 条 error。

### 2026-10-13 上游同步冲突时没开 issue
- 现象：同步 1.81.0 冲突时（run 38342737019），Telegram 说“已开 issue 交给 Hub 修复 agent”，但仓库里没有 issue，运行还显示绿色。
- 原因：
  - 冲突在“Merge upstream”步骤里被处理掉了（记录 conflict=true、放弃合并），步骤本身成功。
  - 开 issue 的步骤条件是 `if: failure()`，所以被跳过，整个运行显示成功。
  - Telegram 通知在开 issue 之前发送，不管 issue 开没开，都写“已开 issue”。
- 修复：
  - 冲突或任一步失败都会开 issue，并且在发通知之前开，拿到 issue 链接。
  - 同一上游提交只在 issue 里报告一次，不会每小时重复评论。
  - 通知如实写出是新开 issue、补充评论、已报告过，还是开失败。
  - “已合并”改为以 PR 步骤成功为准：PR 链接在合并之前就已经产生。
  - 冲突时运行标红。
- 新增演练：手动运行时勾选 `drill`，走冲突流程，但不合并、不推送，issue 用 `meridian-sync-drill` 标签，不会唤醒修复 agent。
- 验证：分支上演练两次（run 38356497828、38356589414）。第一次开了 #39，通知在开 issue 之后发出；第二次同一上游提交没有重复评论；两次都标红。#39 已关闭。
- 另：工作流注释原来写定时任务从 main 触发，实际默认分支就是生产分支，已改正。

### 2026-10-13 agy 锁定到 1.3.4（同上游的锁版本方式）
- 改动：
  - 版本门禁改成和上游一样，只认一个验证过的版本，现在是 `1.3.4`。原来放宽为任意 `1.x`、可用 `MERIDIAN_AGY_ANY_VERSION=1` 跳过检查，这两项都去掉了。
  - `/health` 的 `verifiedCliVersion` 改为 1.3.4。
  - 测试、fixture、设置证明 / 工具目录 / idle / 回放轮询这几个脚本里固定的版本和哈希，一并改成 1.3.4。
  - 新增测试：确认 1.2.7 会在 `/config` 之前就被拒绝。
- 官方二进制（GitHub release 1.3.4，和发布页公布的 sha256 一致）：
  - macOS arm64：压缩包 `ede28149…`，可执行文件 `9da414c0…53f5`。
  - Linux arm64：压缩包 `56161a18…`，可执行文件 `08d619ae…4824`。
- 验证：
  - **设置证明**（作者的 `e2e-antigravity-account-settings.mjs`）：macOS 和 Linux 上的 1.3.4 都是 `customModelsConfig` null、`modelProvider` ""、`useG1Credits` false（布尔）、`gcp` null，和 1.2.7 一样。
  - **单元测试**：上游分支 5341 pass，22 个隔离组全过；fork 的 antigravity / replay 测试 437 pass。
  - **macOS 实测**（MacBook Air，Pi 1.1.0）：basic、tools、recovery、Pi recovery、expansion、openai-tools、responses-state、Pi extensions、interruption 通过。pi-clients、capabilities、gap-closure、Pi lost-answer / lost-tool / disconnect、idle 没过。
    - 同样这几项用未修改的上游 main + agy 1.2.7 跑，也一样不过（capabilities 除外）。
    - capabilities 两次失败的原始响应都是谷歌返回 `Eligibility check failed: UNAVAILABLE (code 503)`；单独复现时，1.3.4 和 1.2.7 的结果完全一样。
    - 当时生产（agy 1.2.16）同一小时也有 503。没有发现 1.3.4 特有的问题。
  - **Linux（SG，acc1 环境，单独实例）**：settings、recovery、expansion、openai-tools、responses-state、interruption 通过。gap-closure 先是缺 lark，补上后又遇到谷歌 503。
  - **账号检查耗时**：MacBook Air 上 1.3.4 和 1.2.7 轮流各 8 次，全部成功；两个版本都偶尔慢到 15–34 秒。
  - **面板登录脚本**：`agy-login.py` 在 1.3.4 下也能拿到授权链接，结束后不留进程。
- 未覆盖：OpenCode 相关的测试（含 tool-catalog）、native-tools、media、desktop。
- 上游：没有提 PR，由用户自己测试几天后再提。上游用的分支 `feat/agy-1.3.4` 保留着。
- 发布与部署：
  - `v1.81.0-cd1s.3`（`93db290`，provenance `package-1.81.0-1-detached-93db2903`，非 dirty），bundle sha256 `5757f3a4…`。
  - 部署顺序：先把 `/usr/local/bin/agy` 原子替换为官方 1.3.4（Linux arm64，sha256 `08d619ae…`），旧的 1.2.16 保留为 `/usr/local/bin/agy-1.2.16`。再加 drop-in `meridian-accounts.service.d/agy-pin.conf`（`AGY_CLI_DISABLE_AUTO_UPDATE=true`）。最后替换 `dist-accounts` 并重启。
  - 重启后 acc22 第一次账号检查两次超时（1.3.4 在每个账号目录里第一次运行较慢），约 70 秒后启动器自动重试恢复。最终 20 个账号在服务，失败的仍是 acc20 / acc21 / acc23（部署前就失败）。
- 回滚：
  - 把 `/usr/local/bin/agy-1.2.16` 复制回 `/usr/local/bin/agy`；
  - 把 `dist-accounts.old-09f6b64-20261013-150708` 改回 `dist-accounts`；
  - 删掉 `agy-pin.conf`，执行 `systemctl daemon-reload`，再重启服务。
  - 打包备份在 `/opt/meridian/backups/live-09f6b64-agy1216-before-93db290-20261013-150638.tgz`（sha256 `94762c4c…`），并已 `agent-backup put`。
- 验证：
  - acc1 / acc2 / acc22 的 `/health` 都显示 `cliVersion` 1.3.4、`verifiedCliVersion` 1.3.4。
  - 跨账号：acc1 发起 `tool_use`，用 acc2 的 key 发 tool_result，日志 `agy_account_affinity holder=acc1 status=200`，回答包含随机码。
  - 回放测试：直接回答 3/3；轮询 3/3（提示 → 再读 → `done`）。
  - 部署后 11 个请求全部 200，没有出现 “Unsupported agy version”，也没有异常。

## 同步上游


```bash
git fetch upstream
git checkout ours/antigravity-gateway-patch
git rebase upstream/main
```
