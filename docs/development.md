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
| GET | `/dsh-gal/asset/ui/dialog.json` | 对话框底图的裁切与排版几何 |
| GET | `/dsh-gal/asset/ui/{dialog.png,settings.png,click.wav}` | 固定 UI 素材 |
| GET | `/dsh-gal/asset/sprite?pack=&file=` | 立绘图片 |
| GET | `/dsh-gal/asset/voice?pack=&file=` | 语音文件 |

素材路由只返回扫描到的文件名，路径穿越（`../`）在结构上就不可能。

## 两类自检

```powershell
node scripts/verify.mjs        # 128 项端到端自检
node scripts/layout-probe.mjs  # 真实浏览器排版探针（无浏览器时自动跳过）
npm test                       # 两个一起跑
```

* **`verify.mjs`**：用一个假的 Cordis 上下文启动真实宿主插件，把每个 HTTP 路由真实调用一遍，
  并用临时 `DSH_HOME` 保证不碰实际配置。覆盖 PNG 裁切、CSV 解析、定价、全部路由、用量记账、
  档位与配置迁移、隐形 UI 不吃点击、控件单位一致性、没有内容表的语音包、BOM 检查等。
* **`layout-probe.mjs`**：把真实的 `client.js` 装进无头 Edge/Chrome，驱动真实档位按钮逐档量
  实际 DOM，分四种内容页各量一遍（是否放得下、是否居中、文字颜色、字号上限）。

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
│   ├── packs.js              # 立绘包 / 语音包扫描与随机抽取
│   ├── csv.js                # 台词对照表解析（支持跨行引号字段）
│   ├── pricing.js            # DeepSeek 官方定价 + 峰谷时段
│   ├── usage.js              # 余额接口 + 差额记账
│   └── png-alpha.js          # 零依赖 PNG 透明通道扫描（自动裁切立绘）
├── assets/
│   ├── ui/                   # dialog.png / dialog.json / settings.png / click.wav
│   ├── pricing.json          # 可编辑的定价表
│   └── packs/
│       ├── README.md         # 包格式说明
│       └── neri/             # 内置示例包：pack.json / script.csv / 18 张立绘 / 405 条语音
└── scripts/
    ├── verify.mjs            # 128 项端到端自检
    └── layout-probe.mjs      # 真实浏览器排版探针
```

## 打包与发布

发行方式是 **GitHub Releases**，带素材的完整包挂在 Release 上：

```powershell
npm pack                          # 打全量包，约 119MB
# 然后在 GitHub 上建 Release，把 tgz 作为 asset 传上去
```

日常开发不必发版，`link:` 装源码目录即可（只建目录联接、不复制素材，改完刷新页面生效）：

```powershell
dsh plugin --profile desktop add link:C:\path\to\dsh-gal
```

* `package.json` 的 `files` 已包含 `lib`、`scripts`、`assets/**`、`cordis.patch.yml`、`docs`、
  `README.md`、`LICENSE`，`npm pack` 出来的就是可直接安装的完整包。
* 版本号改了记得同步 Release 的 tag 与文件名（`v1.19.0` / `dsh-gal-1.19.0.tgz`）。
* 每次发版**同时传一个不带版本号的 `dsh-gal.tgz`**：插件精选列表的条目用
  `releases/latest/download/dsh-gal.tgz` 指向预构建包。
* 仓库自带 `.github/workflows/verify.yml`，推上去会自动跑两类自检。
