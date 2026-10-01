# Meridian Fork 补丁说明（Cd1s/meridian）

本仓库是上游 [rynfar/meridian](https://github.com/rynfar/meridian) 的自定义分支，主分支为 `ours/antigravity-gateway-patch`，基准上游分支为 `main`。
原则：不改官方 agy 的生成行为（模型名、思考等级、提示词都原样透传），只改分发层的兼容性和速度。

## 补丁清单

| 补丁 | 涉及文件 | 说明 |
| :--- | :--- | :--- |
| 放宽 agy 1.2.14 版本门禁 | `src/proxy/backends/antigravityRuntime.ts` | 上游只认 `1.2.7`；Linux ARM64 官方最新是 `1.2.14` |
| 丢弃 `temperature` / `top_p` / `top_k` | `src/proxy/backends/antigravityProtocol.ts` | agy 没有采样参数；上游直接 400，Sub2API 的账号测试固定带 `temperature`，会全部失败。`betas` 仍按上游拒绝 |
| 授权检查可选缓存 `MERIDIAN_AGY_ACCOUNT_CHECK_TTL_MS` | `src/proxy/types.ts`、`antigravityRuntime.ts` | 上游每个请求都冷启动一次 `agy -p /config`（经代理约 5s）。设 TTL 后，成功结果在 TTL 内复用；失败不缓存。默认 0 = 上游行为，上限 600000 |

## 线上配置（<生产机>，`/etc/systemd/system/meridian@.service`）

```
Environment="MERIDIAN_AGY_ALLOW_TOOL_BRIDGE=1"
Environment="MERIDIAN_AGY_ACCOUNT_CHECK_TTL_MS=300000"   # fork 补丁：授权检查成功后 5 分钟内不重查
Environment="MERIDIAN_AGY_TOOL_TIMEOUT_MS=300000"        # 上游选项：已完成对话的热进程保留 5 分钟，续轮免冷启动
```

## 变更记录

### 2026-10-02 temperature 兼容 + 提速
- 原因：Sub2API 测试 acc1-4 报 `Antigravity does not support temperature`（之前手工改 dist 的热补丁被 3202811 的重新部署覆盖）；单请求约 12s。
- 实测拆解（经 socks 代理）：`agy -p /config` 4.7–5.6s（每请求）+ CLI 冷启动握手约 4.5s + 模型 2.5–4s。
- 验证：在远端编译机跑 antigravity 全部测试 175 pass / 0 fail，`tsc --noEmit` 0 错误，构建成功；
  线上 4 实例带 `temperature` 请求均 200；Sub2API `POST /admin/accounts/{<id>,<id>,<id>,<id>}/test`（`gemini-3.8-flash`）全部 success。
- 效果：新对话 12s → 6.5–7s；同一对话续轮 2.5–3.5s（`/health` 的 `reused` 计数增长）。偶发 40s+ 是 Google `streamGenerateContent` 自身慢。
- 回滚点：`/opt/meridian/backups/dist-20261002-021937`（temperature 补丁前）、`dist-20261002-022938` 与 `meridian@.service-20261002-022938`（提速前）；还原后 `systemctl daemon-reload && systemctl restart meridian@acc{1..4}`。
- 线上影响：4 个实例各重启，单次约 10s 不可用。
- 同日：acc4（<账号邮箱>）重新登录成功，实测可用（此前判断的 ToS 封禁不成立），`meridian@acc4` 已 enable。

## 同步上游

```bash
git fetch upstream
git checkout ours/antigravity-gateway-patch
git rebase upstream/main
```
