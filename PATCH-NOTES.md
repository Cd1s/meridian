# Meridian Fork 补丁说明（Cd1s/meridian）

本仓库是上游 [rynfar/meridian](https://github.com/rynfar/meridian) 的自定义分支，主分支为 `ours/antigravity-gateway-patch`，基准上游分支为 `main`。
原则：不改官方 agy 的生成行为（模型名、思考等级、提示词都原样透传），只改分发层的兼容性和速度。

## 补丁清单

| 补丁 | 涉及文件 | 说明 |
| :--- | :--- | :--- |
| 放宽 agy 1.2.14 版本门禁 | `src/proxy/backends/antigravityRuntime.ts` | 上游只认 `1.2.7`；Linux ARM64 官方最新是 `1.2.14` |
| 丢弃 `temperature` / `top_p` / `top_k` | `src/proxy/backends/antigravityProtocol.ts` | agy 没有采样参数；上游直接 400，Sub2API 的账号测试固定带 `temperature`，会全部失败。`betas` 仍按上游拒绝 |
| 思考等级选择同系列官方 slug | `src/proxy/backends/antigravityProtocol.ts`、`antigravityRuntime.ts` | Sub2API 把纯名（如 `gemini-3.8-flash`）映射到 `-low`；客户端带 `effort` / `reasoning_effort` 时换成同系列 `-<effort>`（上游 budget 适配也是这样换后缀）。账号没有该档（3.1 Pro 无 medium）时取最近档，优先更高。非 `gemini-*-low/medium/high` 模型仍按上游报错 |
| 授权检查可选缓存 `MERIDIAN_AGY_ACCOUNT_CHECK_TTL_MS` | `src/proxy/types.ts`、`antigravityRuntime.ts` | 上游每个请求都冷启动一次 `agy -p /config`（经代理约 5s）。设 TTL 后，成功结果在 TTL 内复用；失败不缓存。默认 0 = 上游行为，上限 600000 |
| 探测结果后台刷新（同一开关） | `antigravityRuntime.ts` | 设了 TTL 时：授权检查和模型列表（`agy models`，上游固定 60s 缓存，此时取 max(60s, TTL)）过期后，若距上次成功不到 6×TTL，请求直接用旧结果，后台跑一次刷新；刷新失败立即清掉缓存，之后请求同步检查/被拦。超过 6×TTL 回到同步检查 |

## 线上配置（<生产机>，`/etc/systemd/system/meridian@.service`）

```
Environment="MERIDIAN_AGY_ALLOW_TOOL_BRIDGE=1"
Environment="MERIDIAN_AGY_ACCOUNT_CHECK_TTL_MS=300000"   # fork 补丁：授权检查成功后 5 分钟内不重查
Environment="MERIDIAN_AGY_TOOL_TIMEOUT_MS=300000"        # 上游选项：已完成对话的热进程保留 5 分钟，续轮免冷启动
Environment="MERIDIAN_AGY_ADAPT_THINKING_BUDGETS=1"      # 上游选项：budget_tokens ≤2048 low / ≤8192 medium / 其余 high
Environment="MERIDIAN_AGY_MAX_CONCURRENT=8"              # 上游选项（默认 4）：热进程多了不必互相回收；每进程约 225MB
```

Sub2API 账号 <id>/<id>/<id>/<id> 的 `model_mapping`：纯名 → `-low`（如 `gemini-3.8-flash → gemini-3.8-flash-low`），带后缀的原样。

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

## 同步上游

```bash
git fetch upstream
git checkout ours/antigravity-gateway-patch
git rebase upstream/main
```
