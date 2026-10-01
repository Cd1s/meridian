# Meridian Fork 补丁说明（Cd1s/meridian）

本仓库是上游 [rynfar/meridian](https://github.com/rynfar/meridian) 的自定义分支，主分支为 `ours/antigravity-gateway-patch`，基准上游分支为 `main`。

## 补丁核心功能

| 功能 | 涉及文件 | 说明 |
| :--- | :--- | :--- |
| **放宽 agy 1.2.14 版本门禁** | `src/proxy/backends/antigravityRuntime.ts` | 上游官方写死仅支持 `1.2.7`，补丁仅放宽门禁以支持 Google 官方 Linux ARM64 最新版 `1.2.14`，其余完全保持官方原生行为 |

## 同步上游命令

```bash
git fetch upstream
git checkout ours/antigravity-gateway-patch
git rebase upstream/main
```
