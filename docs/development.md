# 开发、验证与发布

> [README.md](../README.md) 的补充材料。

## 余额与花费是怎么算出来的

### 余额

`GET https://api.deepseek.com/user/balance`，用 DSH 里配置的 `DEEPSEEK_API_KEY` 鉴权。
结果缓存 25 秒，并发请求会合并；网络抖动时继续显示上一次的值并标注「（缓存）」。

### 今日已用

两种来源，自动选择：

1. **官方用量接口**（准确）—— 需要配置 `DEEPSEEK_PLATFORM_TOKEN`，调用
   `platform.deepseek.com/api/v0/usage/by_api_key/amount`，按真实 token 分桶计价。
2. **余额差额记账**（保底）—— 只需要 `DEEPSEEK_API_KEY`：每次读到余额就和上一次比较，
   **减少的部分记为消费**，累加进当天用量；跨天自动归零并把前一天归档到 `history`。

记账有两个刻意的保护：

* **充值不会记成负数**：余额上升时只更新基准，不计入消费。
* **币种切换不会记出假账**：CNY ↔ USD 跳变时只重设基准，不把汇率差当成消费。

账本文件：`%USERPROFILE%\.dsh\.dsh-gal-usage.json`

### 每轮消耗

挂件监听 DSH 的 `session/event` 事件流：

* `assistant/message` 带着每一步真实的 `usage`（输入 / 缓存命中 / 输出 / 推理 token），
  按 `(会话 id, 轮次)` 分桶累加 —— 主会话和并行子代理**不会串账**。
* `turn/end` 时结算该会话本轮，生成一个自增的 `seq`；前端轮询到 `seq` 变化就弹对话框。

> **`seq` 怎么对齐**（`readTurnPoll`）：计数器在宿主进程里从 0 开始数，所以「页面加载**前**
> 就已经结算的那一轮」和「马上要结算的这一轮」在前端看来长得一样 —— 前者不能弹（每次刷新都
> 重放一遍旧收据很蠢）。规则是：bootstrap 会告诉前端**当前**计数，此后任何增加都是新的一轮；
> 万一 bootstrap 失败，就把第一次轮询到的值当作基准，不弹。
>
> 早期版本把「之前计数是 0」当成「这次读数只是基准」，于是**每次重启 DSH 后的第一轮对话都
> 不弹收据** —— 而重启后的第一条，恰恰是用户最可能在盯着的那一条。

计价用 DeepSeek 官方价（人民币 / 百万 token），区分高峰与空闲时段，详见
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

素材路由只会返回**扫描到的文件名**，路径穿越（`../`）在结构上就不可能。

## 两类自检

```powershell
cd <克隆下来的 dsh-gal 目录>

node scripts/verify.mjs        # 128 项端到端自检
node scripts/layout-probe.mjs  # 真实浏览器排版探针
npm test                       # 两个一起跑
```

**`verify.mjs`** 不需要 DSH 进程、不需要联网：它用一个假的 Cordis 上下文启动**真实的宿主
插件**，把每个 HTTP 路由都真实调用一遍，并用一个临时 `DSH_HOME` 保证不碰你的实际配置。
覆盖 PNG 裁切、CSV 解析、定价、全部路由、用量记账、档位与配置迁移、隐形 UI 不吃点击、
控件单位一致性、**没有内容表的语音包**、BOM 检查等。

**`layout-probe.mjs`** 把**真正的 `client.js`** 装进无头 Edge/Chrome，用假 API 喂进最长
的那条台词，再驱动**真实的档位按钮**逐档量出实际 DOM，分四种内容页各量一遍：台词要放得下，
数字页还要**量出水平居中偏移**（取的是文字本身的包围盒，不是容器）与**文字颜色**；最后用
一次真实的立绘点击换成**最短的那条台词**，量它有没有被放大到填满对话框。没装浏览器时自动
跳过（exit 0）。

> 为什么需要探针：对话框的自适应字号依赖**真实字体度量**，靠手算 CJK 字宽反复和实际不符。
> 已经靠它抓到五个看代码看不出来的 bug —— 二分搜索得到 6.19px 后被 `toFixed(1)` 进位到
> 6.2px，那 0.01px 正好把一个字挤到下一行；`clientHeight` 的整数舍入放过了 1.3px 的溢出；
> 「CSS 断言过了、实际却没居中」——`.dsg-foot-full{max-width:none}` 写得没错，但
> `applyLayout()` 写的**行内** `max-width` 优先级更高，数字页于是在左边 66% 的窄条里居中
> （实测偏 −10.5px ～ −38.4px，框越大偏得越多）；「越大越好」的自适应把 1 个字的台词一路
> 顶到 44px（10 档实测占掉对话框高度的 49%），现在由 `MAX_LINE_FONT = 28` 兜住；以及
> **假数据比真实情况宽松**——探针原来喂的是 `seq` 1→2，而真实冷启动是 0→1，于是漏掉了
> 「重启后第一轮不弹收据」这个 bug，现在每个阶段都要断言**屏幕上到底是哪一张内容页**。

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

```powershell
npm pack --pack-destination dist   # 打成本地 tarball
npm publish                        # 发布到 npm
```

* `package.json` 的 `files` 已包含 `lib`、`scripts`、`assets/**`、`cordis.patch.yml`、
  `docs`、`README.md`、`LICENSE`。
* 内置语音包约 **125MB**、立绘约 **14MB**，tarball 约 **119MB**（解包约 146MB，447 个文件，
  其中 426 个是素材）。
* 介意体积的话可以只保留少量示例素材，把完整语音包交给用户自己放进
  `%USERPROFILE%\.dsh\dsh-gal\packs\`。**注意**：`scripts/verify.mjs` 里有几条断言
  写死了内置包的数量（18 张立绘 / 405 条语音），裁剪素材后请同步改掉，否则 CI 会红。
* 发 GitHub 建议用 **Git LFS** 跟踪 `assets/packs/**`，或把 `assets/packs/neri/voices/`
  加进 `.gitignore`。
* 仓库自带 `.github/workflows/verify.yml`：推上去会自动跑两类自检，不需要装任何依赖。
