# 自定义素材与配置

> [README.md](../README.md) 的补充材料。

## 放哪里

| 内容 | 用户目录（推荐，升级不丢） | 插件内置目录 |
|---|---|---|
| 立绘包 / 语音包 | `%USERPROFILE%\.dsh\dsh-gal\packs\` | `<插件目录>\assets\packs\` |
| 对话框图片 | `%USERPROFILE%\.dsh\dsh-gal\ui\dialog.png` | `<插件目录>\assets\ui\dialog.png` |
| 对话框几何 | `%USERPROFILE%\.dsh\dsh-gal\ui\dialog.json` | `<插件目录>\assets\ui\dialog.json` |
| 设定图标 | `%USERPROFILE%\.dsh\dsh-gal\ui\settings.png` | `<插件目录>\assets\ui\settings.png` |
| 点击音效 | `%USERPROFILE%\.dsh\dsh-gal\ui\click.wav` | `<插件目录>\assets\ui\click.wav` |
| 定价表 | `%USERPROFILE%\.dsh\dsh-gal\pricing.json` | `<插件目录>\assets\pricing.json` |

**用户目录优先**：放同名文件就覆盖内置的，插件升级也不会被冲掉。

> **包是整体覆盖，不是合并。** 用户目录里出现一个叫 `neri` 的目录，哪怕它只有 `voices\`，
> 也会把内置的 `neri` 整个换掉 —— 内置那 18 张立绘会一起消失。想给内置包**补**东西（比如
> 换上完整语音包），**另起一个包名**（如 `neri-voice`），再用设定面板把「立绘包 / 语音包」
> 分别选成两个不同的包。

## 立绘包 / 语音包

```
<包根目录>\
└── mychar\                 ← 目录名就是包 id，设置面板里显示的就是它
    ├── pack.json           ← 可选：显示名 / 默认立绘 / 手动裁切
    ├── sprites\            ← 立绘：png jpg webp gif avif bmp
    │   ├── 01.png
    │   └── 02.png
    ├── voices\             ← 语音：wav mp3 ogg oga m4a aac flac
    │   ├── my0001.wav
    │   └── my0002.wav
    └── script.csv          ← 可选：语音 → 台词对照表
```

* 只放 `sprites\` → 立绘包；只放 `voices\` → 语音包；两者都放就是一个包两用。
* 图省事也可以**不建子目录**，把图片和语音直接丢在包目录里，一样会被识别。
* 立绘的透明边距会被**自动裁掉**（扫描 PNG 透明通道），不需要自己切图。
* `voices\` 里**有台词的行会被优先随机到**，所以对话框不会空着。

### 默认立绘怎么定

对话框消失后立绘会切回**默认立绘**（常态姿势）。规则只有两条：

| 优先级 | 怎么声明 |
|---|---|
| 1 | `pack.json` 里的 `defaultSprite`，例如 `"defaultSprite": "01.png"` |
| 2 | **没写 → 系统自动选一张**：按**自然顺序**取第一张，所以 `2.png` 排在 `10.png` 前 |

第 2 条保证**任何立绘包都一定有默认立绘** —— 丢一堆图进去、什么配置都不写也能用。
文件名没有特殊含义：`Default.png` 只是一张普通立绘。设置面板的「立绘包」下面会写明当前用
的是哪张、以及是 `pack.json 指定` 还是 `自动选定`。

### `script.csv` 格式

```csv
clip,chapter,speaker_jp,japanese,chinese,sec
my0001,1,ねり,旅行、行こうよ！,去旅行嘛！,1.725
my0002,2,ねり,お兄ちゃんいまパンツ見たでしょ！,哥哥刚才是不是在看我的内裤！,2.114
```

* `clip` 必须和 `voices\` 里的**文件名（不含扩展名）**一致：`my0001` ↔ `my0001.wav`。
* `japanese` / `chinese` 两列分别对应设定里的「日文 / 中文」。
* 字段可以用双引号包住，**允许换行**（官方台词表里就有跨行台词）。
* 列名认不出来时按 `clip,chapter,说话人,日语,中文,时长` 的位置兜底。
* 没有 `script.csv` 也能用：这时没有台词可显示，点击立绘改为显示「余额 / 今日已用」，
  语音和随机立绘都不受影响。

### `pack.json`（可选）

```json
{
  "displayName": "我的角色",
  "defaultSprite": "01.png",
  "crop": { "x": 0.164, "y": 0.168, "w": 0.679, "h": 0.832 }
}
```

| 字段 | 说明 |
|---|---|
| `displayName` | 设置面板下拉里显示的名字，缺省用目录名 |
| `description` | 包的说明文字，可省略 |
| `defaultSprite` | 默认立绘文件名。**这是指定默认立绘的唯一方式**；写的文件不存在时自动回退到自动选定 |
| `crop` | 手动指定裁切范围（0~1）。**通常不用写** —— 会自动扫描 PNG 透明通道。只有 JPG（没有透明通道）或自动结果不满意时才需要 |

> 只有上面四个字段会被读取。包 id 一律取**目录名**，对照表在包目录和 `voices\` 里自动找
> `.csv`（`script` 开头的优先）—— 所以内置示例 `pack.json` 里的 `id` / `script` 只是写给
> 自己看的，删掉也不影响。

## 换掉对话框底图：`dialog.json`

换成自己的对话框图片时，同目录放一个 `dialog.json` 描述它的几何：

```json
{
  "image": { "width": 1280, "height": 720 },
  "crop":  { "x": 0, "y": 0.42, "w": 1, "h": 0.58 },
  "inset": { "left": 0.05, "right": 0.05, "top": 0.07, "bottom": 0.04 },
  "footer": { "heightRatio": 0.42, "maxWidthRatio": 0.66 },
  "radius": 10
}
```

| 字段 | 说明 |
|---|---|
| `crop` | **显示原图的哪一块**（0~1）。默认只取下方 58%，把上方空白裁掉 |
| `inset` | 内容区相对裁切后画面的内边距 |
| `footer.heightRatio` | 底栏（余额 / 花费）高度最多占文字区的比例，0.15–0.7 |
| `footer.maxWidthRatio` | 底栏最多横向占多宽，0.3–1 —— 用来避开右下角的 logo |
| `radius` | 圆角像素 |

> 台词页会把底栏整个藏起来，画面全留给台词；金额页的底栏会填满画面，但**竖向只用到内高的
> 72%**（写死在 `lib/client.js` 的 `LOGO_SAFE_SHARE`），保证不压到 logo。

## 定价表

`pricing.json`（用户目录优先）—— 改价不用改代码：

```json
{
  "updatedAt": "2026-08-17",
  "peakHours": [[9, 12], [14, 18]],
  "weekendOffPeak": true,
  "models": {
    "deepseek-v4-flash": { "hit": [0.05, 0.1], "miss": [1.5, 3.0], "out": [4.5, 9.0] },
    "deepseek-v4-pro":   { "hit": [0.15, 0.3], "miss": [4.5, 9.0], "out": [13.5, 27.0] },
    "_default":          { "hit": [0.05, 0.1], "miss": [1.5, 3.0], "out": [4.5, 9.0] }
  }
}
```

每条是 `[空闲时段价, 高峰时段价]`，单位人民币 / 百万 token。高峰为北京时间周一至周五
09:00–12:00 与 14:00–18:00，周末全天按空闲价。推理 token 按输出价计费。

## 配置文件

`%USERPROFILE%\.dsh\.dsh-gal.json`：

```json
{
  "version": 3,
  "spritePack": "neri",
  "voicePack": "neri",
  "spriteFile": "large_neri_07face.png",
  "scale": 5,
  "volume": 0.5,
  "lang": "ja",
  "autoPlay": false,
  "autoPlayMinutes": 1,
  "dialogScale": 5,
  "dialogEnabled": true,
  "dialogSide": "above",
  "dialogOpacity": 0,
  "dialogHoldSeconds": 3,
  "spriteRevertOnHide": true,
  "spriteVisible": true,
  "pos": { "hx": "right", "hd": 24, "vy": "bottom", "vd": 24 },
  "extraPackRoots": []
}
```

| 键 | 说明 |
|---|---|
| `scale` | 立绘档位 1–10，默认 5（≈50%）。超范围的值写入时会被夹到边界 |
| `dialogScale` | 对话框档位 1–10，默认 5（= 基准宽度的 20%）。**单位与立绘不同**，改版时重定过标 |
| `volume` | 0–1 的小数 |
| `lang` | `ja`（日文）或 `zh`（中文） |
| `autoPlay` / `autoPlayMinutes` | 自动播放开关与间隔（分钟，0.5–240） |
| `dialogEnabled` | 对话框总开关 |
| `dialogSide` | `above`（立绘上方）或 `below` |
| `dialogOpacity` | **百分比** 0–95。0 = 原图完全不透明，越大越透明 |
| `dialogHoldSeconds` | 语音播完后停留几秒再淡出，默认 3，范围 0.5–120 |
| `spriteRevertOnHide` | 对话框消失后是否切回默认立绘，默认 `true` |
| `spriteVisible` | 设为 `false` 只隐藏立绘，保留对话框 |
| `pos` | 位置锚点：`hx` 为 `left`/`right`，`hd` 是离该边的像素距离；`vy` 为 `top`/`bottom`，`vd` 同理 |
| `extraPackRoots` | 额外的包目录数组，每个目录的**直接子目录**会被当成包 |
| `pricingFile` | 自定义定价表的绝对路径 |

改完存盘，**刷新页面**生效（不需要重启）。

> **从旧版本升级**：老配置里的 `scale` / `dialogScale` 是 0.2–2.0 的小数，读取时自动换算成
> 1–10 档（`0.7 → 7 档`，老的 200% 上限夹到 10 档）；v2 → v3 时对话框档位还会整体 ×2.5
> 重定标以保持视觉大小不变。迁移后的文件会自动写回。
