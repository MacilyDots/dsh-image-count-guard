# dsh-image-count-guard

DSH 视觉模型会话的「图片张数超限」兜底插件。

## 它解决什么问题

上游网关可能对单个请求里的图片数量设硬上限（实测 OpenCode Go：**20 张**）。但 `dsh-llm-pi-ai` 适配器的图片预算**只按 base64 字节**算（`maxRequestImageBytes`，默认 20 MiB），没有按张数的预算，于是：

1. 会话历史里图片累积到 36 张（原始 11.79 MiB / base64 约 15.72 MiB）；
2. 切到视觉模型（`opencode-go/deepseek-v4.1-flash`）后，15.72 MiB < 20 MiB，适配器认为请求没问题，36 张全部内联发出；
3. 网关回 `400 INVALID_REQUEST`：`a request may include at most 20 images`；
4. 官方 `dsh-compaction-image-offload` 只认 `IMAGE_OFFLOAD_REQUIRED`，不认这个错误码 → 本步失败；
5. 之后该会话**每一步都失败**（连发「继续」也一样），会话彻底卡死。

## 它做什么

挂到 `agent/request-error` waterfall 上：

- 失败文本命中图片数量限制（`at most N images` / `maximum of N images` / `no more than N images` / `up to N images` / `too many images`，且必须出现 "image" 字样）时；
- 统计当前 surface 上**尚未省略**的图片出现位置总数 `total`；
- 记录一条 `image/offload` 决定，按模型请求顺序选取最旧的 `max(1, total - (limit - safetyMargin))` 个出现位置；
- 返回 `{ kind: 'retry' }`，本步重试（不消耗 provider 重试预算）。

复用的是官方同一份 `image/offload` 投影，所以占位文本、回放、token 计量、KV cache 语义全部与官方卸载一致。每次重试至少省略一个出现位置，因此**恢复必然终止**：要么请求放得下，要么没有可省略的图片，原失败保持终态（不会无限重试）。

## 与官方 image-offload 的关系

| 场景 | 处理者 |
|---|---|
| 适配器自己按字节预算拒绝（`IMAGE_OFFLOAD_REQUIRED`） | 官方 `dsh-compaction-image-offload` |
| 上游网关按**张数**拒绝（`INVALID_REQUEST` 等） | 本插件 |

两者写同一种 `image/offload` 事件，互不冲突。本插件不依赖官方 handler 的注册顺序，只依赖 `image/offload` 投影已注册；若投影未注册（官方插件被禁用），`append` 抛错，本插件捕获后把失败交回下游，不产生副作用。

## 安装

```powershell
# 在克隆下来的仓库目录里执行
pwsh -File .\install.ps1                 # 装进 desktop profile（默认）
pwsh -File .\install.ps1 -Profile web    # 装进指定 profile
```

脚本手工改 profile 三处（`dependencies` / `dsh.profile.bundles` / `pnpm-lock.yaml`）并复制 node_modules 副本（**不跑 pnpm install**，避免顺带升级其它 `^` 依赖），改前自动备份到 `.backup\<时间戳>\`（只保留最近 5 份）。

插入位置全部使用结构锚点（`"dependencies": {`、`"bundles": [`、lock 的 `packages:` / `snapshots:` 段头），不依赖其它插件是否存在，也不依赖本机路径。DSH 家目录取 `$env:DSH_HOME`，未设置时用 `~\.dsh`。

**装完必须重启 DSH。**

卸载：

```powershell
pwsh -File .\install.ps1 -Uninstall
```

## 配置（可选）

默认无需配置。需要时在 profile 的 `cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: image-count-guard
  config:
    defaultImageLimit: 20      # 错误文本里没给数字时假定的上限
    safetyMargin: 2            # 卸载后保留的余量，避免新增一张图又失败
    maxOffloadPerRetry: 80     # 单次重试最多省略多少张
```

## 验证

1. 静态：`install.ps1` 末尾会打印 deps / bundles / node_modules / lock 四项校验。
2. 离线单测：`node --test test/guard.test.mjs`（11 个用例，覆盖匹配、选择、收敛轮数上界、无副作用边界）。
3. 组装验证（可选）：把插件挂进一个临时 profile 并 `--dump-config`，确认 entry 被组装。已实测输出含 `# == dsh-image-count-guard` / `- id: image-count-guard`，退出码 0。
4. 线上：重启后打开那个卡死的会话，发一句「继续」。插件生效时该会话会记录一条 `image/offload` 事件，随后请求成功。

## 诊断工具

```powershell
# 单个会话：图片数、已省略数、原始字节、base64 估算、平均单图大小
node tools\session-image-report.mjs `
     "$env:USERPROFILE\.dsh\sessions\<workspace>\session-<id>\session.v4.jsonl.zstd"

# 扫描最近会话，按图片数排序
node tools\session-image-report.mjs "$env:USERPROFILE\.dsh\sessions" --limit 20
```

实测两类会话：

| 会话 | 图片数 | base64 载荷 | 平均单图 | 只按字节的预算是否拦得住 |
|---|---|---|---|---|
| `session-c312057f` | 36 | 15.72 MiB | 335 KiB | 否（低于 20 MiB 默认预算，一张都不卸载） |
| `session-b15b99cb` | 25 | 1.52 MiB | 47 KiB | 否（字节太小，调小预算也难与张数对齐） |

第二行就是本插件存在的理由：张数超限与字节预算无关，只有按张数处理才拦得住。

## 已知边界

- **省略不可回退**：被省略的图片此后以占位文本（含附件只读路径）出现，这是官方 `image/offload` 的固有语义。需要重新看图就再让模型 `read_image` 一次。
- 错误文本必须是英文且含 `image` 与数量措辞；新增网关措辞时在 `src/index.js` 的 `LIMIT_PATTERNS` 里补一条。
- 修改 `src/index.js` 后必须重跑 `install.ps1` 同步 `node_modules` 副本，否则 DSH 加载的仍是旧代码。
