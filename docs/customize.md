# 自定义素材与配置

> [README.md](../README.md) 的补充材料。

## 放哪里

首次运行时插件会建好 `%USERPROFILE%\.dsh\dsh-gal\`，里面有 `packs\`（附一份格式速查）和 `ui\`，
把文件丢进去即可；用户目录优先，且插件升级不会被冲掉。

| 内容 | 用户目录 | 插件内置目录 |
|---|---|---|
| 立绘包 / 语音包 | `%USERPROFILE%\.dsh\dsh-gal\packs\` | `<插件目录>\assets\packs\` |
| 对话框图片 | `%USERPROFILE%\.dsh\dsh-gal\ui\dialog.png` | `<插件目录>\assets\ui\dialog.png` |
| 对话框几何 | `%USERPROFILE%\.dsh\dsh-gal\ui\dialog.json` | `<插件目录>\assets\ui\dialog.json` |
| 设定图标 | `%USERPROFILE%\.dsh\dsh-gal\ui\settings.png` | `<插件目录>\assets\ui\settings.png` |
| 点击音效 | `%USERPROFILE%\.dsh\dsh-gal\ui\click.wav` | `<插件目录>\assets\ui\click.wav` |
| 定价表 | `%USERPROFILE%\.dsh\dsh-gal\pricing.json` | `<插件目录>\assets\pricing.json` |

**包是整体覆盖、不是合并**：用户目录里出现叫 `neri` 的目录，哪怕只放 `voices\`，也会把内置的
`neri` 整个换掉。只想补语音就另起一个包名（如 `neri-voice`），再用设定面板把「立绘包 / 语音包」
分别选成两个包。改完刷新页面生效。

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
* 也可以不建子目录，把图片和语音直接丢在包目录里。
* 立绘的透明边距会自动裁掉，不需要自己切图。
* `voices\` 里有台词的行会被优先随机到。

### 默认立绘怎么定

对话框消失后立绘切回**默认立绘**（常态姿势）：

| 优先级 | 怎么声明 |
|---|---|
| 1 | `pack.json` 里的 `defaultSprite`，例如 `"defaultSprite": "01.png"` |
| 2 | 没写 → 按自然顺序取第一张（`2.png` 排在 `10.png` 前） |

设置面板的「立绘包」下面会写明当前用的是哪张、以及是 `pack.json 指定` 还是 `自动选定`。

### `script.csv` 格式

```csv
clip,chapter,speaker_jp,japanese,chinese,sec
my0001,1,ねり,旅行、行こうよ！,去旅行嘛！,1.725
my0002,2,ねり,お兄ちゃんいまパンツ見たでしょ！,哥哥刚才是不是在看我的内裤！,2.114
```

* `clip` 必须和 `voices\` 里的文件名（不含扩展名）一致：`my0001` ↔ `my0001.wav`。
* `japanese` / `chinese` 两列分别对应设定里的「日文 / 中文」。
* 字段可以用双引号包住，允许换行；列名认不出来时按 `文件名,章节,说话人,日语,中文,时长` 的位置兜底。
* 台词里夹着的音效标记（如 `えいっ<dash=2>、ねいっ。`）会被**自动去掉**，不用自己清理；
  `1 < 2` 这种正常的尖括号不受影响。
* 没有 `script.csv` 也能用，只是点击立绘改为显示余额页。

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
| `defaultSprite` | 默认立绘文件名；写的文件不存在时回退到自动选定 |
| `crop` | 手动指定裁切范围（0~1）。通常不用写：会自动扫描 PNG 透明通道；只有 JPG 或自动结果不满意时才需要 |

包 id 取目录名，对照表在包目录和 `voices\` 里自动找 `.csv`（`script` 开头的优先）。

## 换掉对话框底图：`dialog.json`

**首选在设定面板里换**：「对话框」一组里的 `更换图片…` 选一张自己的图、`空白底图` 换成自带的
纯白面板、`恢复默认` 还原——三者都立即生效，插件会自动为新图写好几何。
手改文件也行（用户目录优先，改完刷新页面即可）：

```
%USERPROFILE%\.dsh\dsh-gal\ui\dialog.png     ← 你的底图
%USERPROFILE%\.dsh\dsh-gal\ui\dialog.json    ← 描述它的几何
```

换成自己的对话框图片时，同目录放一个 `dialog.json` 描述它的几何：

```json
{
  "image": { "width": 1280, "height": 720 },
  "crop":  { "x": 0, "y": 0.42, "w": 1, "h": 0.58 },
  "inset": { "left": 0.05, "right": 0.05, "top": 0.07, "bottom": 0.04 },
  "footer": { "heightRatio": 0.42, "maxWidthRatio": 0.66 },
  "radius": 10,
  "logoShare": 0.72
}
```

| 字段 | 说明 |
|---|---|
| `crop` | 显示原图的哪一块（0~1）。默认只取下方 58%，把上方空白裁掉 |
| `inset` | 内容区相对裁切后画面的内边距 |
| `footer.heightRatio` | 底栏（余额 / 花费）高度最多占文字区的比例，0.15–0.7 |
| `footer.maxWidthRatio` | 底栏最多横向占多宽，0.3–1 |
| `radius` | 圆角像素 |
| `logoShare` | 底栏最多用掉文字区高度的几分之几。自带底图右下角有 logo，所以是 `0.72`；自己的底图没有 logo 就写 `1`，余额/花费页会用满整块 |

自带的空白底图是 `assets\ui\dialog-blank.png` + `dialog-blank.json`（1200×700、`crop` 全图、
`logoShare: 1`），用 `node scripts/make-blank-plate.mjs` 重新生成。

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
09:00–12:00 与 14:00–18:00，周末全天按空闲价；推理 token 按输出价计费。

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
| `scale` | 立绘档位 1–10，默认 5 |
| `dialogScale` | 对话框档位 1–10，默认 5（单位与立绘不同） |
| `volume` | 0–1 的小数 |
| `lang` | `ja`（日文）或 `zh`（中文） |
| `autoPlay` / `autoPlayMinutes` | 自动播放开关与间隔（分钟，0.5–240） |
| `dialogEnabled` | 对话框总开关 |
| `dialogSide` | `above`（立绘上方）或 `below` |
| `dialogOpacity` | 百分比 0–95。0 = 原图完全不透明，越大越透明 |
| `dialogHoldSeconds` | 语音播完后停留几秒再淡出，默认 3，范围 0.5–120 |
| `spriteRevertOnHide` | 对话框消失后是否切回默认立绘，默认 `true` |
| `spriteVisible` | 设为 `false` 只隐藏立绘，保留对话框 |
| `pos` | 位置锚点：`hx` 为 `left`/`right`、`hd` 是离该边的像素距离；`vy` 为 `top`/`bottom`、`vd` 同理 |
| `extraPackRoots` | 额外的包目录数组，每个目录的直接子目录会被当成包 |
| `pricingFile` | 自定义定价表的绝对路径 |

设定面板里改（缩放 / 位置 / 不透明度 / 选包 / 换底图）**立即生效**。
手改这个文件需要**重启 DSH Desktop**——配置是插件启动时读入一次，之后走内存；
`ui\` 下的素材与 `packs\` 都是每次请求实时读的，刷新页面即可。
