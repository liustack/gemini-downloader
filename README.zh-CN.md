# banana-downloader

中文文档。英文文档请见 [README.md](README.md)。

这是一个用于 Google Gemini 的 Chrome 扩展：点击扩展图标后，会在页面内直接拉起面板，支持批量下载当前对话中的生成图片原图，并自动去除水印。

## 使用声明

本项目仅用于个人学习，禁止用于任何商业用途。

## 功能特性

- 页面内 Shadow DOM 面板（不依赖 popup）
- 自动检测 Gemini 生成图片并支持全选/反选
- 通过模拟点击原生下载按钮 + fetch 拦截获取原图
- 自动去除 Gemini 水印（Background 中进行逆向 alpha 混合）
- 批次时间戳命名，避免文件名冲突（`prefix_YYYYMMDD_HHmmss_N.png`）
- 下载进度与结果实时反馈

## 工作原理

扩展采用三层架构：

| 层 | 文件 | 运行环境 | 职责 |
|----|------|----------|------|
| 拦截器 | `public/download-interceptor.js` | Main World | 补丁 `window.fetch`，从 Gemini 下载重定向链中捕获原图 blob |
| Content Script | `src/content/index.ts` | Isolated World | UI 面板 + 编排下载流程（查找按钮 → 点击 → 等待 blob → 发送给 Background） |
| Background | `src/background/index.ts` | Service Worker | 水印去除 + 文件保存 + 原生下载抑制 |

**下载流程：**

1. 点击扩展图标 → Background 向当前 Gemini 页面发送 `TOGGLE_PANEL`
2. Content Script 扫描页面图片并渲染面板
3. 用户选择图片后点击下载
4. Content Script 注入 Main World 拦截器并启用下载抑制
5. 串行处理每张图片：点击原生下载按钮 → 拦截器通过补丁 `fetch` 捕获 blob → 通过 `postMessage` 转发给 Content Script
6. Content Script 发送 `DOWNLOAD_IMAGE`（含 dataUrl + filename）给 Background
7. Background 去除 Gemini 水印后通过 `chrome.downloads` 保存文件

## 技术栈

- Chrome Extension Manifest V3
- TypeScript 5.9
- Vite 6.4 + `@crxjs/vite-plugin` 2.3
- pnpm

## 项目结构

```text
src/
  background/index.ts          # action 点击处理 + 水印去除 + 下载抑制
  content/index.ts             # 图片扫描 + 页内面板 UI + 下载编排
  core/
    watermarkEngine.ts         # 逆向 alpha 混合去水印
    alphaMap.ts                # 预计算 alpha 通道映射
    blendModes.ts              # 混合模式工具
  types.ts                     # 消息与数据类型
  assets/                      # 水印参考图
public/
  download-interceptor.js      # Main World fetch 补丁（运行时注入）
  rules.json                   # Declarative Net Request CORS 规则
  icons/                       # 扩展图标
docs/                          # 操作文档与架构文档
manifest.json
AGENTS.md                      # AI agent 项目上下文
```

## 本地开发

```bash
pnpm install
pnpm dev
```

然后在 Chrome 中：

1. 打开 `chrome://extensions`
2. 开启开发者模式
3. 点击"加载已解压的扩展程序"
4. 选择 `dist/` 目录

## 构建

```bash
pnpm build
```

构建产物输出到 `dist/`。

## 使用方式

1. 打开 `https://gemini.google.com/`
2. 进入包含生成图片的对话
3. 点击扩展图标
4. 在页面右上角面板中选择图片并下载

## 常见问题

### 点击图标没有弹出面板

- 刷新 Gemini 页面后重试（content script 需要注入到最新页面）
- 确认加载的是最新 `dist/`

### 检测不到图片

- 确认当前对话中已有已渲染完成的图片
- 向下滚动触发懒加载后再点图标

### 下载失败

- 确认 Gemini 登录状态正常
- 查看 `chrome://extensions` 中该扩展的 Errors / Service Worker 日志

## 权限说明

- `activeTab`：处理当前活动标签页并进行 action 交互
- `downloads`：调用 Chrome 下载 API
- `declarativeNetRequestWithHostAccess`：修改 `lh3.googleusercontent.com` 图片请求的响应头（CORS）
- `host_permissions`：
  - `https://gemini.google.com/*` — 注入内容脚本并与页面交互
  - `https://lh3.googleusercontent.com/*`、`https://lh3.google.com/*` — 访问图片资源用于水印处理

## 许可证

MIT，详见 [LICENSE](LICENSE)。
