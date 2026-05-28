# APK Workshop

桌面 APK 资源工作台，当前主架构为：

- `Tauri 2`
- `React 18`
- `TypeScript`
- `Vite 6`
- `Tailwind CSS 3`
- `TanStack Query`
- `i18next + react-i18next`
- `Rust commands`

## 当前已实现

- 自动扫描 `apk/*.apk`，也可手动选择 APK
- APK 解包到工作区并生成 `manifest.json`
- APK 资源浏览、搜索、分组筛选
- 普通文件预览：图片、文本、二进制摘要
- 普通 APK 文件替换
- APK 重封包
- 调试签名能力检测与签名
- Unity Bundle 解包、解包全部 Bundle
- Bundle 节点/资源汇总浏览
- Bundle 图片、文本、音频预览
- TextAsset 替换、Bundle 重封
- `AudioClip` 自动导出为可播放音频，并兼容刷新旧工作区

## 一键运行

```bash
./run-app.sh preview
```

其他模式：

```bash
./run-app.sh dev
./run-app.sh tauri-dev
./run-app.sh tauri-build
```

可选环境变量：

```bash
HOST=0.0.0.0 PORT=1421 ./run-app.sh preview
```

## 开发

```bash
npm install
npm run dev
```

如本机具备 Rust/Tauri 环境：

```bash
npm run tauri:dev
```

## 目录结构

前端：

- `src/app/`：应用入口、全局样式、国际化初始化
- `src/features/workbench/`：APK Workshop 主工作台功能
- `src/shared/api/`：Tauri 命令调用封装
- `src/shared/lib/`：通用工具函数
- `src/shared/types/`：前后端共享数据类型
- `src/shared/ui/`：通用 UI 组件

Rust 原生层：

- `src-tauri/src/application/`：Tauri commands、运行时状态、DTO 模型
- `src-tauri/src/domain/apk/`：APK 扫描、解包、替换、重封、签名
- `src-tauri/src/domain/bundle/`：Unity Bundle 解析、解包、资源导出、替换、重封
- `src-tauri/src/domain/preview/`：图片、文本、音频、二进制预览
- `src-tauri/src/support/`：路径、时间、JSON、文件等基础支持

## 构建 App

```bash
npm run tauri:build
```

macOS 产物默认位于：

- `src-tauri/target/release/bundle/macos/`
- `src-tauri/target/release/bundle/dmg/`

Windows 可直接运行根目录脚本：

```bat
build-windows.bat
```

脚本行为：

- 自动检测 `winget / Node.js / npm / Rust / cargo / rustc / Visual Studio C++ Build Tools / WebView2`
- 缺失时优先通过 `winget` 自动安装
- 自动切换 Rust 到 `stable-x86_64-pc-windows-msvc`
- 自动加载 MSVC 构建环境后执行 `npm run tauri:build`
- WebView2 若安装返回异常码，会再次复检；若系统已存在则不再阻塞打包

Windows 打包前需确保本机已安装：

- `winget`（即 Windows App Installer）
- PowerShell 或 `pwsh`

Windows 产物默认位于：

- `src-tauri\target\release\bundle\nsis\`
- `src-tauri\target\release\bundle\msi\`
