# APK Workshop

纯 Go + Fyne 桌面 App，用于对 APK 做文件级拆解、资源预览、替换和重新封包。

## 功能范围

- 自动扫描 `apk/*.apk`，也可手动选择 APK。
- 解包到 `work/<apk-name>/`，生成 `manifest.json`。
- 资源浏览、路径搜索、按 `assets/res/lib/classes/META-INF` 和资源类型筛选。
- 预览 PNG/JPG/WebP/GIF/BMP、JSON/XML/TXT/Lua/properties、Unity Bundle 节点摘要、二进制摘要。
- 替换 APK 内直接文件，支持整 `.bundle` 文件替换。
- 选中 `.bundle` 后可在右侧面板解包 UnityFS，并解析 Unity 资源对象：TextAsset 导出真实文本，Texture2D 可解码格式导出 PNG 预览，Sprite/AudioClip 等显示资源类型和元数据。
- 顶部可一键解包全部 Bundle，左侧 `Bundle资源/Bundle图片/Bundle文本/Bundle音频/Bundle其他` 会汇总已解包 Bundle 内资源，并可跳转回对应 Bundle 操作。
- 支持替换 TextAsset 文本/代码资源并重封 Bundle。
- 封包到 `dist/<apk-name>-unsigned.apk`，构建时移除旧签名文件。
- 可选 debug 签名，使用 `.apkworkshop/debug.keystore`。

## 边界

- 首版不修改 `dex`、`so`。
- Bundle 支持 UnityFS v6/v7 的无压缩、LZ4、LZ4HC；LZMA、加密或未知格式会明确提示不支持。
- 首版支持 TextAsset 对象内容替换；Texture2D 支持 RGB24/RGBA32/ARGB32/ETC2_RGBA8 预览解码，但暂不做像素写回；Sprite/AudioClip 暂显示元数据。
- 首版不做破解、防护绕过、热更新劫持、证书伪造。
- 缺少 `zipalign/apksigner` 时仍可输出未签名 APK，App 会提示签名不可用。

## 运行

```bash
go run ./cmd/apkworkshop
```

需要 Go 1.24 或更高版本。

## 构建

```bash
go build -o bin/apkworkshop ./cmd/apkworkshop
```

## 签名工具

签名需要本机可执行：

- `keytool`
- `zipalign`
- `apksigner`

`keytool` 通常来自 JDK，`zipalign/apksigner` 来自 Android SDK Build-Tools。
