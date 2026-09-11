# 立绘包 / 语音包放这里

本目录（`assets/packs/`）是**插件内置**的包目录。宿主还会扫描一个**用户目录**，它优先于
这里、并且在插件升级时不会被覆盖：

```
%USERPROFILE%\.dsh\dsh-gal\packs\
```

一个包就是一个文件夹，**目录名即包 id**：

```
<包名>/
├── pack.json          # 可选：显示名、默认立绘、裁切范围
├── sprites/           # 立绘（png / jpg / webp / gif / avif / bmp）
├── voices/            # 语音（wav / mp3 / ogg / m4a / aac / flac）
└── script.csv         # 可选：语音文件名 → 台词对照表
```

* `sprites/` 与 `voices/` 可以只放其中一个：只放立绘就是立绘包，只放语音就是语音包。
* 立绘的透明边距会自动裁掉，不需要自己切图。
* 默认立绘由 `pack.json` 的 `defaultSprite` 指定；没写就按自然顺序取第一张。
* 用户目录里的**同名包会整体覆盖**内置包（不是合并），只想补语音请另起一个包名。

格式细节（`script.csv` 列名、`pack.json` 字段、`crop` 用法）见
**[docs/customize.md](../../docs/customize.md)**。
