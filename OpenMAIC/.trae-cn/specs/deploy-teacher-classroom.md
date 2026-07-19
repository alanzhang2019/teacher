# 方案 2：教师建课 · 学生访问 — Cloud Deployment Spec

> 目标：将 OpenMAIC 部署到云服务器（阿里云 ECS / 腾讯云 CVM），实现"老师建课 → 生成课件 → 学生通过 access code 访问"。
> 范围：利用现有 access code 机制，不引入完整用户系统（账号/密码/角色），通过两个 access code 区分身份。

---

## 1. 现状梳理（哪些已经做好 / 哪些要改）

### ✅ 已有能力
| 能力 | 文件 | 状态 |
|---|---|---|
| 客户端 access code 拦截 | [components/access-code-guard.tsx](file:///d:/AItrade/openmaic/OpenMAIC/components/access-code-guard.tsx) | ✅ 已实现，调 `/api/access-code/status` |
| HMAC 签名 token | [lib/server/access-token.ts](file:///d:/AItrade/openmaic/OpenMAIC/lib/server/access-token.ts) | ✅ 已实现 |
| Access Code Modal | [components/access-code-modal.tsx](file:///d:/AItrade/openmaic/OpenMAIC/components/access-code-modal.tsx) | ✅ 已实现 |
| 课堂 JSON 落盘 | [lib/server/classroom-storage.ts](file:///d:/AItrade/openmaic/OpenMAIC/lib/server/classroom-storage.ts) | ✅ 文件系统持久化（`data/classrooms/<id>.json`） |
| 课堂 CRUD API | [app/api/classroom/route.ts](file:///d:/AItrade/openmaic/OpenMAIC/app/api/classroom/route.ts) | ✅ POST 创建 / GET 读取 |
| TTS 后台队列 | [lib/server/tts-queue.ts](file:///d:/AItrade/openmaic/OpenMAIC/lib/server/tts-queue.ts) | ✅ 服务端队列 + JSON 持久化 |
| 音频静态服务 | `public/audio-cache/<id>.wav` | ✅ Next.js 直接 serve |

### ❌ 缺失能力（方案 2 要做的）
| 缺口 | 影响 |
|---|---|
| **scenes / agents 数据在客户端 IndexedDB** | 学生访问 `/classroom/[id]` 拿不到 scenes/agents/聊天记录 |
| **access code 没区分老师 / 学生身份** | 任何人拿到 access code 都能建课 |
| **图片存客户端 IndexedDB** | 学生看不到老师生成的图片 |
| **VoxCPM 在老师本机** | 学生访问时 TTS 没法跑（除非学生本机也跑 VoxCPM） |
| **没有"我的课堂"管理页** | 老师找不到自己创建的课堂 |
| **课堂数据没绑老师身份** | 老师 A 创建的课堂，access code 一泄露老师 B 也能改 |

---

## 2. 架构（目标态）

```
┌────────────────────┐         ┌──────────────────────┐
│ Teacher Browser    │         │ Student Browser      │
│ (IndexedDB 缓存)   │         │ (只读，不存数据)      │
└────────┬───────────┘         └────────┬─────────────┘
         │ HTTPS                       │ HTTPS
         ▼                             ▼
┌─────────────────────────────────────────────────────┐
│            OpenMAIC (Next.js, :3000)                │
│ ┌────────────────────────────────────────────────┐   │
│ │  /api/access-code/*     — 身份校验             │   │
│ │  /api/classroom/*       — 课堂 CRUD            │   │
│ │  /api/classroom/:id/scenes   — 场景数据       │   │
│ │  /api/classroom/:id/assets   — 图片 / 音频    │   │
│ │  /api/generate/tts-background — TTS 任务      │   │
│ └────────────────────────────────────────────────┘   │
└────────┬──────────────────────────────┬─────────────┘
         │                              │
         ▼                              ▼
┌──────────────────┐         ┌──────────────────────┐
│ Postgres (:5432) │         │ VoxCPM TTS (:8000)   │
│ - classrooms     │         │ - server.py          │
│ - scenes         │         │ - watchdog.ps1       │
│ - assets         │         │ - CPU/GPU            │
│ - access_tokens  │         └──────────────────────┘
│ - users (teacher)│
└──────────────────┘
```

---

## 3. 关键设计

### 3.1 身份（双 access code）

| 角色 | 环境变量 | 用途 |
|---|---|---|
| **Teacher Code** | `OPENMAIC_TEACHER_CODE` | 老师身份。拿到后可以：建课、改课、删课、看所有课堂 |
| **Class Access Code** | Postgres `classrooms.access_code` 列 | 单个课堂的学生访问码。6-8 位短码 |

- 验证流程：
  1. `AccessCodeGuard` 启动时调 `/api/access-code/status` → 返回 `{ needsTeacher, needsClass, classId? }`
  2. 优先要求 Teacher Code（建课/管理路径）
  3. 访问 `/classroom/[id]` 时要求 Class Access Code（只读）
  4. Teacher Code 可以直接进任何课堂（管理身份）

### 3.2 数据迁移

**Postgres schema**：
```sql
CREATE TABLE teachers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash TEXT NOT NULL,        -- bcrypt(TEACHER_CODE)
  name TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE classrooms (
  id TEXT PRIMARY KEY,            -- 复用 stage.id
  teacher_id UUID REFERENCES teachers(id),
  name TEXT NOT NULL,
  stage JSONB NOT NULL,           -- Stage 元数据
  access_code_hash TEXT NOT NULL, -- bcrypt(6-8 位短码)
  is_published BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE scenes (
  id TEXT PRIMARY KEY,
  classroom_id TEXT REFERENCES classrooms(id) ON DELETE CASCADE,
  type TEXT, title TEXT, "order" INT,
  content JSONB,                  -- SceneContent
  actions JSONB,
  whiteboard JSONB,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
);
CREATE INDEX scenes_classroom ON scenes(classroom_id, "order");

CREATE TABLE classroom_assets (
  id TEXT PRIMARY KEY,            -- 与 IndexedDB key 对齐
  classroom_id TEXT REFERENCES classrooms(id) ON DELETE CASCADE,
  kind TEXT,                      -- 'image' | 'audio' | 'video' | 'agent' | 'voice_profile'
  blob BYTEA,                     -- 媒体二进制
  meta JSONB,                     -- mime/filename/duration/prompt 等
  created_at TIMESTAMPTZ
);
```

> **音频单独存盘**：`public/audio-cache/<id>.wav` 保留文件存储（已工作），DB 只存元数据，方便 Next.js 静态服务。

### 3.3 客户端同步

**老师端**（写）：
- 场景生成完成后 `POST /api/classroom/:id/scenes` 全量推 scenes
- 图片/媒体生成后 `POST /api/classroom/:id/assets` 上传 blob
- IndexedDB 保留为本地缓存（断网可继续编辑）

**学生端**（读）：
- 访问 `/classroom/[id]` 拉 `GET /api/classroom/:id/full`（一次性拿 stage + scenes + asset 列表）
- 图片/音频直接走 `public/audio-cache/*` + `public/classroom-assets/*` 静态 URL
- **不写** IndexedDB（避免占用学生设备空间）

### 3.4 部署架构

**目录**：
```
/opt/openmaic-teacher/
├── docker-compose.yml
├── .env                          # OPENMAIC_TEACHER_CODE, DB password, model dir
├── openmaic/                     # Next.js build
│   ├── .next/standalone
│   ├── public/
│   └── ...
├── voxcpm/
│   ├── server.py
│   ├── watchdog.sh               # Linux 版本的 watchdog
│   └── models/                   # 挂卷，5GB VoxCPM2
└── postgres-data/                # 挂卷
```

**docker-compose.yml** 服务：
| Service | Image | Ports | Notes |
|---|---|---|---|
| `postgres` | `postgres:16-alpine` | 5432 (内部) | 数据卷 |
| `voxcpm` | 自建 (PyTorch CPU) | 8000 (内部) | 5GB 模型挂卷 |
| `openmaic` | 自建 (Node 22) | 3000 (公开) | 通过 `voxcpm:8000` 调 TTS |

**VoxCPM 容器化**（基于 `pyproject.toml`）：
```dockerfile
FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . /app
RUN pip install --no-cache-dir -e . torch==2.5.1 --index-url https://download.pytorch.org/whl/cpu
EXPOSE 8000
CMD ["python", "server.py"]
```
> **首次启动**预下载模型：`snapshot_download("openbmb/VoxCPM2", cache_dir="/models")` 写入挂卷。

**OpenMAIC 容器**：复用现有 `Dockerfile` standalone build，加 Postgres 客户端 (`pg` / `prisma` / `drizzle`)。

---

## 4. 实施任务清单

### Phase 1：存储层（2-3 天）
- [ ] **T1.1** 引入 Postgres 客户端（推荐 `drizzle-orm`，轻量 + TypeScript first）
- [ ] **T1.2** 建 schema 迁移：`teachers` / `classrooms` / `scenes` / `classroom_assets` / `access_codes`
- [ ] **T1.3** 重写 `lib/server/classroom-storage.ts`：fs → drizzle，保留 `readClassroom` / `persistClassroom` 签名兼容
- [ ] **T1.4** 新增 `app/api/classroom/[id]/scenes/route.ts`：GET / PUT 全量推场景
- [ ] **T1.5** 新增 `app/api/classroom/[id]/assets/route.ts`：GET 列表 / POST 上传 / `public/classroom-assets/` 静态服务

### Phase 2：身份与权限（2-3 天）
- [ ] **T2.1** 双 access code 校验：`POST /api/access-code/teacher` + `POST /api/access-code/class`
- [ ] **T2.2** `AccessCodeGuard` 改为按路由分级（管理页要 teacher code，课堂页要 class code）
- [ ] **T2.3** 服务端中间件 (`middleware.ts`) 注入 role 到 request header
- [ ] **T2.4** 课堂 CRUD API 加 teacher 鉴权（teacher 必须 = classroom.teacher_id）

### Phase 3：UI 改造（2-3 天）
- [ ] **T3.1** 新增 `app/dashboard/page.tsx` — 老师"我的课堂"管理页（列表 / 新建 / 复制 access code 链接 / 删除）
- [ ] **T3.2** `use-scene-generator.ts` 在生成完成时调 `POST /api/classroom/:id/scenes` 同步到 server
- [ ] **T3.3** `media-orchestrator.ts` 媒体生成后调 `POST /api/classroom/:id/assets` 上传
- [ ] **T3.4** `/classroom/[id]/page.tsx` 改为"无 IndexedDB 模式"：从 `/api/classroom/:id/full` 拉所有数据，音频/图片走静态 URL
- [ ] **T3.5** 课堂详情页加 "Publish" 开关（is_published=true 才允许学生访问）

### Phase 4：VoxCPM 容器化（1-2 天）
- [ ] **T4.1** 写 `VoxCPM/Dockerfile`（基于 `pyproject.toml` + torch CPU）
- [ ] **T4.2** `VoxCPM/watchdog.sh`（POSIX 版本，PowerShell → bash）
- [ ] **T4.3** 模型预下载脚本 `VoxCPM/scripts/download_model.sh`（modelscope 国内源）
- [ ] **T4.4** 在 OpenMAIC `.env` 加 `TTS_VOXCPM_BASE_URL=http://voxcpm:8000`

### Phase 5：部署（1-2 天）
- [ ] **T5.1** `docker-compose.yml` 整合 3 个服务
- [ ] **T5.2** Nginx 反代 + HTTPS（Let's Encrypt 或阿里云免费证书）
- [ ] **T5.3** 阿里云 ECS 初始化脚本 `infra/aliyun-init.sh`（docker / 防火墙 / 挂数据盘）
- [ ] **T5.4** 运维文档 `docs/deploy-cloud.md`

### Phase 6：测试 & 上线（1-2 天）
- [ ] **T6.1** E2E：老师建课 → 拿到 access code → 学生访问 → 看到完整课件 → 播放音频
- [ ] **T6.2** 压测：50 并发学生访问同一课堂
- [ ] **T6.3** 备份脚本：每日 dump postgres + audio-cache tar

**总工时估算**：8-12 工作日（一个人）

---

## 5. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 客户端 IndexedDB 已有的课堂数据要迁移 | 提供"导入到 server"按钮（用现有 `exportDatabase` 逻辑） |
| VoxCPM CPU 推理慢，50 并发扛不住 | 部署初期限制单 classroom 最多 20 学生；后续上 GPU |
| Postgres 中文 / emoji 编码问题 | 用 UTF8 + `pg` 客户端的 `text` 类型，不存 bytea 文本 |
| 老师换设备丢失 access code | Teacher Code 存 env，老师用名字找回（v2 加） |
| TTS 任务在 server 跑 30+min，server 重启丢任务 | `tts-queue.ts` 已有 JSON 持久化，但需补上 `docker restart` 后的恢复逻辑 |

---

## 6. 验证清单（完工标准）

- [ ] 老师在 A 电脑建课，复制 `/classroom/abc?code=123456` 链接
- [ ] B 电脑（不同 IP、不同浏览器、没装 VoxCPM）打开链接
- [ ] 通过 access code 验证后看到完整课件（场景、图片、文本）
- [ ] 播放 TTS 正常（无卡顿、无杂音、音量一致）
- [ ] 老师修改课件后，学生刷新即可看到（5s 内）
- [ ] 老师删除课堂，学生访问返回 404

---

## 7. 存储后端抽象（`STORAGE_BACKEND` 切换）

为避免一次改动把现有本地 dev 流（IndexedDB + 本地 fs JSON）拖崩，引入 `ClassroomStorage` 抽象。

### 7.1 接口

`lib/server/storage/types.ts`：

```typescript
export interface ClassroomStorage {
  read(id: string): Promise<PersistedClassroomData | null>;
  write(data: PersistedClassroomData): Promise<void>;
}
```

### 7.2 实现

| 文件 | 后端 | 状态 |
|---|---|---|
| `lib/server/storage/fs-backend.ts` | `fs` | ✅ 已实施（一文件一 JSON，原子写） |
| `lib/server/storage/postgres-backend.ts` | `postgres` | ⏳ Phase 1.1 实施，构造函数抛 fail-fast |
| `lib/server/storage/fs-utils.ts` | (共用) | ✅ `writeJsonFileAtomic` 抽出 |
| `lib/server/storage/index.ts` | factory | ✅ 读 `STORAGE_BACKEND` + `globalThis` 缓存 |

### 7.3 环境变量

`.env` / `.env.local`：

```bash
# default；本地开发不设
STORAGE_BACKEND=fs

# 生产
STORAGE_BACKEND=postgres
DATABASE_URL=postgres://openmaic:secret@db:5432/openmaic
```

### 7.4 兼容性

- 7 个调用方（`app/api/classroom/*`、`app/api/classroom-media/*`、`app/api/generate-classroom/*`、`lib/server/classroom-{generation,job-store,media-generation}.ts`、`tests/server/classroom-generation-retry.test.ts`）**全部无需改动**，`classroom-storage.ts` facade 保留所有原 export。
- `CLASSROOMS_DIR` 仍然从 `classroom-storage.ts` 导出（re-export from fs-backend），`classroom-media` route 读媒体文件的路径不变。
- 媒体文件（`data/classrooms/<id>/media/*`）**永远走 fs**（生产挂数据卷 / 共享存储），postgres 只存 classroom JSON metadata。
- `globalThis.__openmaic_classroom_storage__` 缓存防止 Next.js dev hot-reload 重置 backend。

### 7.5 Postgres Schema（Phase 1.1 待实施）

```sql
CREATE TABLE classrooms (
  id TEXT PRIMARY KEY,
  stage JSONB NOT NULL,
  scenes JSONB NOT NULL DEFAULT '[]'::jsonb,  -- 1.1: split into `scenes` 表
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Phase 1.1 再加：
--   teachers / classroom_assets / access_codes 表 + 鉴权
```

`postgres-backend.ts` 的 `read` / `write` 第一次实施时直接走这一个表即可，后续 Phase 1.1 拆 scenes 表。

---

## 8. 不在本 spec 范围

- 多老师协作建课（v2）
- 学生答题 / 提交作业（v2）
- 课堂实时同步（多学生同步光标 / 切换场景，v3）
- VoxCPM GPU 部署 / 多实例负载均衡（v2）
- 完整的用户系统（账号/密码/OAuth，v3）
