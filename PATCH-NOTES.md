# Meridian Fork 补丁说明（Cd1s/meridian）

本仓库是上游 [rynfar/meridian](https://github.com/rynfar/meridian) 的自定义分支，主分支为 `ours/antigravity-gateway-patch`，基准上游分支为 `main`。

## 补丁核心功能

| 功能 | 涉及文件 | 说明 |
| :--- | :--- | :--- |
| **放宽 agy 版本门禁** | `src/proxy/backends/antigravityRuntime.ts` | 上游写死仅支持 `1.2.7`，补丁允许 Google 官方原生 Linux ARM64 最新版 `1.2.14` |
| **账户探测轻量缓存 (5分钟)** | `src/proxy/backends/antigravityRuntime.ts` | 拦截每次请求重复运行 `agy -p /config` 的严重 IO/网络浪费，将首字/连接建立时间缩短至毫秒级 |
| **自动剔除未支持参数** | `src/proxy/backends/antigravityProtocol.ts` | 客户端或 Sub2API 传入 `temperature`、`top_p`、`top_k`、`betas` 时静默 strip，防止 400 报错 |
| **思考等级与纯净模型名动态映射** | `src/proxy/backends/antigravityProtocol.ts`, `antigravityRuntime.ts` | 支持客户端直接请求 `gemini-3.8-flash`、`gemini-3.7-flash`、`gemini-3.1-pro`，并自动根据 `reasoning_effort` / `effort` / `budget_tokens` 动态映射到 `-low`/`-medium`/`-high` |

## 同步上游命令

```bash
git fetch upstream
git checkout ours/antigravity-gateway-patch
git rebase upstream/main
```
