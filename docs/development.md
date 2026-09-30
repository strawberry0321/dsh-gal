# 开发、验证与发布

> [README.md](../README.md) 的补充材料。

## 余额与花费怎么算

### 余额

`GET https://api.deepseek.com/user/balance`，用 DSH 里配置的 `DEEPSEEK_API_KEY` 鉴权。
结果缓存 25 秒，并发请求合并；网络抖动时继续显示上一次的值并标注「（缓存）」。

### 今日已用

两种来源，自动选择：

1. **官方用量接口**（准确）—— 配置 `DEEPSEEK_PLATFORM_TOKEN` 后调用
   `platform.deepseek.com/api/v0/usage/by_api_key/amount`，按真实 token 分桶计价。
2. **余额差额记账**（保底）—— 只靠 `DEEPSEEK_API_KEY`：每次读到余额就和上一次比较，
   减少的部分记为消费，累加进当天用量；跨天归零并把前一天归档。余额上升（充值）只更新
   基准不计消费，币种跳变也只重设基准。

账本文件：`%USERPROFILE%\.dsh\.dsh-gal-usage.json`

### 每轮消耗

监听 DSH 的 `session/event` 事件流：

* `assistant/message` 带每一步真实的 `usage`（输入 / 缓存命中 / 输出 / 推理 token），
  按 `(会话 id, 轮次)` 分桶累加，主会话与并行子代理不会串账。
* `turn/end` 结算该会话本轮，生成自增的 `seq`；前端轮询到 `seq` 变化就弹对话框。

计价用 DeepSeek 官方价（人民币 / 百万 token），区分高峰与空闲时段，见
[customize.md 的定价表](customize.md)。

## 宿主侧 HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/dsh-gal/client.js` | 浏览器侧脚本 |
| GET | `/dsh-gal/api/bootstrap` | 启动时一次性拉取配置 + 包列表 + 对话框几何 + 余额 + 今日用量 |
| GET | `/dsh-gal/api/state` | 余额与今日用量 |
| GET | `/dsh-gal/api/turn` | 最近一轮的 token / 花费（含自增 `seq`） |
| GET | `/dsh-gal/api/next` | 随机抽一条语音 + 一张立绘（返回台词） |
| GET | `/dsh-gal/api/packs` | 立绘包 / 语音包列表 |
| GET/PUT | `/dsh-gal/api/config` | 读取 / 局部更新配置 |
| GET/PUT/DELETE | `/dsh-gal/api/dialog-image` | 换底图：GET 报当前几何，PUT 传图片或 `?preset=blank`，DELETE 恢复默认 |
| GET | `/dsh-gal/asset/ui/dialog.json` | 对话框底图的裁切与排版几何（每次请求重读，改完即时生效） |
| GET | `/dsh-gal/asset/ui/{dialog.png,settings.png,click.wav}` | 固定 UI 素材 |
| GET | `/dsh-gal/asset/sprite?pack=&file=` | 立绘图片 |
| GET | `/dsh-gal/asset/voice?pack=&file=` | 语音文件 |

素材路由只返回扫描到的文件名，路径穿越（`../`）在结构上就不可能。

### 客户端脚本怎么进到页面里（两条通道，缺一不可）

| 页面形态 | index 从哪来 | 用哪条通道 |
|---|---|---|
| 官方桌面端（`dsh-app://app/`） | 打包好的静态 `dsh-web-frontend/dist/index.html` | **结构化注入行**：`ctx.on('webserver/index-inject', …)` 推 `{ kind: 'script-src', src: '/dsh-gal/client.js' }` |
| web / HTTP（含 `npx dsh web`、社区桌面端） | 宿主 `renderIndex()` 渲染 | `ctx.webServer.tapIndex(html => …)` 插 `<script defer src=…>` |

官方桌面端的注入表由 `collectIndexInjections()` 在**宿主启动时**采集一次、经 IPC 随 boot payload
冻结下发，页面刷新不会重新采集 —— 所以装完必须**完全重启应用**。
注意 `renderIndex()` 的顺序是「先渲染结构化行、再跑 tap」：HTTP 形态下 `script-src` 行已经被渲染成
真正的 `<script src>` 标签，tap 必须**只在没有该标签时**才补一个（否则同一份脚本会加载两次）。
结构化行的种类是固定的六种（`global` / `script` / `script-src` / `script-preload` / `style` / `html`），
遇到未知种类宿主会直接抛错，所以两条通道要按上面的分工来用。

### 现场诊断：客户端到底有没有在跑

插件在官方桌面端「不显示」时，先分清是**没注入**还是**注入了但画不出来**。
唯一可自动化的硬指标：客户端每 60 秒轮询 `/api/state`，宿主因此会刷新余额并重写用量账本
（`%USERPROFILE%\.dsh\.dsh-gal-usage.json`）。**静默**（不发消息）观察这个文件的 mtime：

```powershell
node scripts/desktop-liveness-check.mjs 90   # 90 秒内账本动过 = 客户端脚本真的在跑
```

账本完全不动 = 脚本没有被加载，那时再看 `dsh --profile desktop --dump-config | Select-String dsh-gal`
（有没有装到应用实际使用的 profile）以及**是不是完全重启过**（注入表在应用启动时冻结）。

## 四类自检

```powershell
node scripts/verify.mjs              # 170 项端到端自检
node scripts/layout-probe.mjs        # 真实浏览器排版探针（无浏览器时自动跳过）
node scripts/sprite-starve-probe.mjs # 真实浏览器「图片请求被饿死」探针
node scripts/binding-selftest.mjs    # 语音 ↔ 动作绑定，跑在已装的真实资源包上
npm test                             # 前两个 + binding-selftest
```

* **`verify.mjs`**：用一个假的 Cordis 上下文启动真实宿主插件，把每个 HTTP 路由真实调用一遍，
  并用临时 `DSH_HOME` 保证不碰实际配置。覆盖 PNG 裁切、CSV 解析、定价、全部路由、用量记账、
  档位与配置迁移、隐形 UI 不吃点击、控件单位一致性、没有内容表的语音包、换底图全流程、
  中英日三种包目录名、素材 URL 版本号、语音洗牌池与 weights.json、字节缓存（fetch → blob）、
  语音↔动作同名配对（含 WebP 头解析与旧包不受影响）、BOM 检查等。
* **`layout-probe.mjs`**：把真实的 `client.js` 装进无头 Edge/Chrome，驱动真实档位按钮逐档量
  实际 DOM，**自带底图与空白底图各量一遍**（是否放得下、是否居中、文字颜色、字号上限，
  以及空白底图的图形区是否真的用满了整块）；每遍最后再走一次设定面板的换底图流程
  （真文件输入 → `applyPlate()` → 重排），确认换完不用刷新。
* **`sprite-starve-probe.mjs`**：把 `client.js` 装进无头浏览器后，让**所有非 `blob:` 的图片源
  一律不落地**（模拟真实页面上图片请求被饿死：实测 `stalled` 十秒以上，一发消息才一起放行），
  再用真实指针事件点击立绘、真实下拉框换包，从 canvas 读回画面颜色，确认启动、点击换图、
  设定换包三条路径都还能换图。附带 `DSG_PROBE_CLIENT=<file>` 可以换成任意版本源码跑，
  用来确认这个探针真的能抓到这个 bug。
* **`binding-selftest.mjs`**：不造假包，直接读 `~/.dsh/dsh-gal/packs` 里**真实**的包：
  动画 WebP 的尺寸要从文件头读出来（不能退化成 1:1）、配对命中的那张图必须真的能读、
  没配对的旧包必须仍然走随机抽。幂等，随便跑。

## 目录结构

```
dsh-gal/
├── package.json              # dsh.bundle.patch 指向 cordis.patch.yml
├── cordis.patch.yml          # 把挂件这一行插进 profile 配置树
├── LICENSE / README.md
├── docs/                     # 用法、素材与配置、开发
├── lib/
│   ├── index.js              # 宿主：路由、余额/用量、每轮结算、index 注入
│   ├── client.js             # 浏览器：挂件 UI、拖拽、设定面板、对话框、打字机
│   ├── packs.js              # 立绘包 / 语音包扫描、权重、洗牌池抽取、语音↔动作同名配对
│   ├── csv.js                # 台词对照表解析（支持跨行引号字段）
│   ├── pricing.js            # DeepSeek 官方定价 + 峰谷时段
│   ├── usage.js              # 余额接口 + 差额记账
│   └── png-alpha.js          # 零依赖 PNG 透明通道扫描（自动裁切立绘）
├── assets/
│   ├── ui/                   # dialog.png / dialog.json / dialog-blank.* / settings.png / click.wav
│   ├── pricing.json          # 可编辑的定价表
│   └── packs/
│       ├── README.md         # 包格式说明
│       └── neri/             # 内置示例包：pack.json / script.csv / 18 张立绘 / 405 条语音
└── scripts/
    ├── verify.mjs            # 174 项端到端自检
    ├── layout-probe.mjs      # 真实浏览器排版探针
    ├── sprite-starve-probe.mjs # 图片请求被饿死时立绘仍要能换
    ├── binding-selftest.mjs  # 真实资源包上的语音↔动作配对自检
    ├── desktop-liveness-check.mjs # 官方桌面端里客户端脚本到底在不在跑
    ├── make-blank-plate.mjs  # 生成自带的空白底图（png + json）
    └── mirror-sprites.mjs    # 无损左右镜像一整套立绘（写完逐像素回验）
```

## 打包与发布

发行方式仍是 **GitHub Releases**（带素材的完整包挂在 Release 上），但装插件不必再下 tgz ——
官方客户端的插件页与 `dsh plugin add` 都接受**仓库地址 / 本地目录 / npm 包名**：

```powershell
dsh plugin --profile desktop add https://github.com/strawberry0321/dsh-gal   # 仓库地址（推荐）
dsh plugin --profile desktop add D:\gittttthub\dsh-gal                        # 本地目录（必须绝对路径）
dsh plugin --profile desktop add C:\path\to\dsh-gal.tgz                       # 离线 tgz
```

spec 由 `dsh-plugin-manager` 的 `install-spec.js` 解析：绝对路径 → path/tarball，
`github:`/`git+https://`/托管仓库 URL → git，裸包名 → 注册表（dsh-gal 不在 npm 上，别用这个）。
git 与 path 两种都走 pnpm，安装后**完全重启**才装配宿主路由与注入表。

发版时才需要打 tgz（`npm pack`，约 122MB）并作为 Release asset 上传：

```powershell
npm pack                          # 打全量包
# 然后在 GitHub 上建 Release，把 tgz 作为 asset 传上去
```

日常开发直接装本地目录即可（改 `lib/client.js` 刷新页面生效；改宿主侧要重启）：

```powershell
dsh plugin --profile desktop add D:\path\to\dsh-gal
```

* `package.json` 的 `files` 已包含 `lib`、`scripts`、`assets/**`、`cordis.patch.yml`、`docs`、
  `README.md`、`LICENSE`，`npm pack` 出来的就是可直接安装的完整包。
* 版本号改了记得同步 Release 的 tag 与文件名（`v2.1.0` / `dsh-gal-2.1.0.tgz`）。
* 每次发版**同时传一个不带版本号的 `dsh-gal.tgz`**：README 的安装步骤和插件精选列表的条目都用
  `releases/latest/download/dsh-gal.tgz` 指向预构建包，所以它必须和新版一起传。
* 角色素材包（`noir-pack.zip` / `karuha-pack.zip` / `mashiro-pack.zip`）名字里**不带版本号**，
  同样只有最新版能对外提供：发新版时要一起传，旧版上的副本可以删掉（省一半以上空间）。
  素材包的目录布局用 `sprites/` + `voices/`，这样在只认英文目录名的老版本上也能装。
* 仓库自带 `.github/workflows/verify.yml`，推上去会自动跑两类自检。
