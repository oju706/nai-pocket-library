# NAI 口袋词库

[下载 Android APK](https://github.com/oju706/nai-pocket-library/raw/main/release/NAI-Pocket-Library.apk)

中文安卓 App，用于浏览、收藏和复制 NovelAI 标签与画面提示词。安装 APK 后，手机桌面会出现「NAI 口袋词库」。适用 Android 9 或更新版本，使用系统提供的 Android WebView。

## 1.1 测试版：手机上的用法

- **画师**默认打开「韩国主库」，以 bequiet 的 V5 Curated 为主，共 6,145 位画师。229 KB 小目录随 App 提供；列表显示原版样图，滑动到附近时直接按片段读取原作者服务器上的图片，无需下载整包。可切换「NAX 补充」或导入已有包，默认不混合来源。
- **同人角色**使用 NAX 的 V5 / V4.5 标签和样图。NAX 也提供补充画师数据，进入后可下载约 1.25 MB 共用目录。
- **画面提示词知识**有 33 条原创中文入门知识，按动作、构图、光线、表情、发型、服装和通用写法分类；「在线图鉴」提供 NAX 的 418 条发型／表情样图条目（V5 发型 147、V4.5 发型 152、表情 119）；「原帖资料」保留官方与韩国社区链接。动作、构图、光线尚不是完整韩国带图教程库。
- 每个分类可切换双列看图、图文列表和紧凑文字，并记住显示方式。紧凑文字不加载列表图片。
- 在当前栏点「新增」，填写名称和提示词。备注和配图可选。文字、备注及自己选的配图保存在这台手机。
- 各在线分区有资源检查入口。NAX 检查会同步画师、角色和知识图鉴共用的小目录，有变化时原子覆盖。韩国主库检查核对原文件指纹与目录是否匹配；原文件变化后停止使用旧位置，索引新版当前随应用发布。两者不能等同于已建成独立远程索引仓库。
- 同模型、同画师或角色标签收藏时优先打开已有条目，并补充其他来源样图，保留已有备注。手工新增同标签时提醒编辑已有条目。不同模型独立保留。
- 「工具 → 读取原图提示词」可离线读取原始 PNG 文本和 NovelAI alpha 隐藏元数据，展示正负提示、角色提示和参数；收藏会保留完整生成信息，备份也包含这些内容。截图或清除元数据后的图片无法还原提示词。输入上限 32 MB，alpha 读取上限 800 万像素，不支持 16 位 alpha 隐藏信息及 RGB 隐藏变体。过大的参数不直接放入系统剪贴板，可随词库备份保存。
- 「工具 → 导出备份／从备份恢复」可保存个人条目与自选配图，支持合并或确认后替换。备份限 20 MB。在线图片、完整原包不随备份打包；本地包图片依赖原文件位置，换机或移动文件后可能需要重新关联。
- 「工具 → 检查应用更新」从 GitHub Releases 检查正式版本，打开浏览器下载 APK，再由安卓确认安装。此版本默认检查 `oju706/nai-pocket-library`。使用早期测试包时，可在工具页手动填写该仓库地址。[版本与安装包](https://github.com/oju706/nai-pocket-library/releases)
- 已经有 Arca Live 原版数据文件时，在「画师 → 在线资源 → 导入已有数据包」选择文件。App 在手机上生成目录，后续从原文件按位置读取图片。导入完成后请把原数据包留在选中的位置。

## 来源与署名

- 感谢 **bequiet / baqu2213** 制作原版画师预览库和 55000Q 查看器。App 支持读取其数据格式。 [Curated 原帖](https://arca.live/b/aiart/185691299) · [全量查看器发布帖](https://arca.live/b/aiart/185686780) · [V5 发布目录](https://huggingface.co/baqu2213/PoemForSmallFThings/tree/main/NAIA/NAID5_artist_thumbnail) · [V4.5 发布目录](https://huggingface.co/baqu2213/PoemForSmallFThings/tree/main/NAIA/NAID4.5_artist_thumbnail_31000)
- App 的在线画师和同人角色样图来自 **Carlyone 的 NovelAI Tag Experiments（NAX）**。按模型和标签合并目录，图片仍从原出处按需读取。 [NAX](https://nax.moe/) · [公开标签索引](https://nax.moe/downloads/tags.zip) · [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- 韩国 **DC Inside** 的社区资料可用于查找动作、手势、画师串与画面词。 [姿势原帖](https://gall.dcinside.com/mini/board/view/?id=wrtnw&no=139401) · [手势原帖](https://gall.dcinside.com/mini/board/view/?id=wrtnw&no=138201) · [资料汇总](https://gall.dcinside.com/mini/board/view/?id=wrtnw&no=152281)
- PNG 隐藏元数据依据 [NovelAI 官方格式说明](https://github.com/NovelAI/novelai-image-metadata) 独立实现。原图库与项目代码分别保留来源，NAX 的许可不套用到韩国原包。
- [资源下载报告与韩国教程优先清单](docs/资源下载报告.md) 列明实际下载内容、校验值、原帖署名及尚未收录的部分。

## 构建与发布

当前版本为 1.1（versionCode 2），包名为 `app.nai.pocketlibrary`。构建使用 Windows 上的 PowerShell、JDK 17、Android SDK Platform 35 和 Build Tools 35.0.0。

脚本使用下面的便携工具目录。可用 `-ToolCache` 指定目录位置。

```text
.android-tools/
  jdk/<解压后的 JDK 根目录>/bin/java.exe
  platform/android-35/android.jar
  build-tools/android-15/aapt2.exe
  build-tools/android-15/lib/apksigner.jar
  signing/
```

```powershell
pwsh -NoProfile -File .\build.ps1
```

构建会编译、对齐、签名并验证 APK，生成 `release/NAI-Pocket-Library.apk`。首次构建建立发行签名。请把签名密钥和密码文件备份到私有位置。以后发布升级包时沿用包名和发行签名，并递增 `AndroidManifest.xml` 的 `versionCode`。

源码与文档位于 [GitHub 仓库](https://github.com/oju706/nai-pocket-library)。签名后的 APK 随版本发布。发行密钥、缓存和用户数据包由各自的本机目录管理。

## 后续扩展

页面使用统一条目结构，含分类、名称、模型、提示词、备注、预览和来源。资源转换集中在 `web/sources.js`；网络和文件处理各自独立，方便新增来源。详见 [扩展约定](docs/扩展约定.md)。当前不支持用户安装第三方插件。

## 验证范围

安卓代码编译、APK 签名、PNG 解析算法、备份输入校验及更新版本比较已检查。韩国主库抽查首、中、尾三图，通过真实 HTTP Range 取得共约 503 KB，均与本机原包逐字节一致。浏览器按手机宽度检查布局与主要交互。

系统文件选择、隐藏元数据位图解码、安装升级仍需真实安卓手机验证；电脑界面预览不能代替这些检查。
