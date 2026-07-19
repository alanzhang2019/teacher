# OpenMAIC Teacher

OpenMAIC 教学版 — 一个让老师用 AI 几秒钟生成可交互课件的平台。
本仓库同时包含两个子项目：

| 子项目 | 作用 | 技术栈 |
|---|---|---|
| [`OpenMAIC/`](./OpenMAIC) | 主前端 + API 服务（场景生成、PPT 导出、TTS 编排） | Next.js 16 + React 19 + TypeScript |
| [`VoxCPM/`](./VoxCPM) | 本地 TTS 后端，支持音色克隆 | Python 3.11 + FastAPI + VoxCPM2 |

## 快速开始（本地开发）

参考 [`OpenMAIC/README.md`](./OpenMAIC/README.md) 和 [`OpenMAIC/.env.example`](./OpenMAIC/.env.example)：
1. 在 `OpenMAIC/` 下 `cp .env.example .env.local` 并填好 LLM API Key
2. `cd OpenMAIC && pnpm install && pnpm dev`
3. `cd VoxCPM && uv sync`，启动 `server.py`（参考 `watchdog.ps1`）

## 部署到云服务器（教师建课 / 学生访问）

见 [`OpenMAIC/docs/deploy-cloud.md`](./OpenMAIC/docs/deploy-cloud.md)（待写）。
架构：`OpenMAIC` (Next.js) + `VoxCPM` (TTS) + Postgres（课堂 / 课件持久化），
通过 `docker-compose.yml` 一键起。

## License

MIT — 见 [`OpenMAIC/LICENSE`](./OpenMAIC/LICENSE)。
