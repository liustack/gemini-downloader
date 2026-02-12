# 原图下载拦截方案：技术架构与决策记录

## 1. 问题背景

### 1.1 核心目标

从 Google Gemini 页面批量下载 AI 生成的**原始全尺寸图片**（PNG，通常 ~7MB），而非页面上显示的缩略图（JPEG，1024px）。

### 1.2 Gemini 图片 URL 体系

Gemini 页面中存在两套完全不同的图片 URL：

| 类型 | URL 路径 | 用途 | 示例 |
|------|---------|------|------|
| 显示 URL | `/gg/AMW1TP...` | 页面内展示缩略图 | `lh3.googleusercontent.com/gg/AMW1TP...=s1024-rj` |
| 下载 URL | `/gg-dl/AOI_d_...` | 原生下载按钮触发的签名 URL | `lh3.googleusercontent.com/gg-dl/AOI_d_...=s0-d-I` |

**关键发现：显示 URL 和下载 URL 使用完全不同的 token。** 对显示 URL 做任何后缀改写（如 `=s0`）都无法获取原图。

### 1.3 被否定的方案：URL 后缀改写

最初尝试将显示 URL 的 `=s1024-rj` 后缀改写为 `=s0`，期望获取全尺寸图片。

**失败原因：**
- 显示 URL (`/gg/AMW1TP...`) 和下载 URL (`/gg-dl/AOI_d_...`) 是完全不同的签名 token
- `=s0` 只是告诉 CDN "不限制尺寸"，但 token 本身决定了能否访问原始文件
- 显示 token 只能返回 JPEG 格式的预览图，无论尺寸参数如何设置

## 2. Gemini 原生下载流程逆向分析

通过 Chrome DevTools 抓包分析，完整还原了 Gemini "Download full size" 按钮的下载链路：

### 2.1 流程概览

```
用户点击 "Download full size"
    │
    ▼
[1] POST /_/BardChatUi/data/batchexecute
    RPC: c8o8Fe
    请求体: 图片 token + 会话 ID + CSRF token
    │
    ▼
[2] 响应返回签名的 gg-dl URL
    https://lh3.googleusercontent.com/gg-dl/AOI_d_...=d-I?alr=yes
    │
    ▼
[3] GET gg-dl URL → 302 重定向
    → work.fife.usercontent.google.com/rd-gg-dl/...=s0-d-I?alr=yes
    （响应 content-type: text/plain，包含下一跳 URL）
    │
    ▼
[4] GET rd-gg-dl URL → 302 重定向
    → lh3.googleusercontent.com/rd-gg-dl/...=s0-d-I?alr=yes
    （响应 content-type: text/plain，包含最终 URL）
    │
    ▼
[5] GET 最终 URL → image/png (~7MB)
    原始全尺寸 PNG 图片
    │
    ▼
[6] 页面 JS 创建 blob: URL → <a download>.click() → 触发浏览器下载
```

### 2.2 RPC 请求格式 (c8o8Fe)

```
POST /_/BardChatUi/data/batchexecute

请求体:
f.req=[[["c8o8Fe", INNER_JSON, null, "generic"]]]
&at=CSRF_TOKEN    // 来自 WIZ_global_data.SNlM0e

INNER_JSON 包含:
- 图片 token (如 "$AedXnj...")    // 从 Angular 组件内存中持有
- 内容类型 URL
- 提示词文本
- 响应/会话 ID (r_xxx, rc_xxx, c_xxx)
- 会话级 token
```

### 2.3 为什么不能直接构造 RPC 请求

- **图片 token 不可获取**：token（如 `$AedXnj...`）存储在 Angular 组件的内存中，生产模式下 Angular 不暴露 `ng.getComponent()` 等调试 API
- **会话参数复杂**：需要 CSRF token、会话 ID、响应 ID 等多个参数，且这些参数在不同会话间变化
- **维护成本高**：RPC 格式是内部协议，随时可能变更

## 3. 当前方案：拦截原生下载流程

### 3.1 核心思路

既然无法自行构造下载请求，那就**借用 Gemini 页面自身的下载逻辑** —— 触发原生下载按钮，让页面 JS 完成所有 RPC 和重定向工作，我们只在最后一步拦截已经 fetch 到的图片 blob。

### 3.2 架构图

```
┌─────────────────────────────────────────────────────────┐
│ Main World (页面 JS 上下文)                              │
│                                                         │
│  download-interceptor.js (通过 <script src> 注入)        │
│  ┌─────────────────────────────────────────────────┐    │
│  │ Patch window.fetch                              │    │
│  │    - 拦截 /gg-dl/ 和 /rd-gg-dl/ 的响应          │    │
│  │    - 当 content-type 为 image/* 时克隆 blob      │    │
│  │    - 转为 dataURL 通过 postMessage 发送          │    │
│  └─────────────────────────────────────────────────┘    │
│                                  │ postMessage          │
│                                  ▼                      │
├──────────────────────────────────┼──────────────────────┤
│ Isolated World (Content Script)  │                      │
│                                  │                      │
│  src/content/index.ts            │                      │
│  ┌───────────────────────────────┼─────────────────┐    │
│  │ startDownload() 流程:         │                 │    │
│  │  1. 通知 Background 启用       │                 │    │
│  │     suppress (取消 blob 下载)  │                 │    │
│  │  2. 遍历选中图片:              │                 │    │
│  │     a. 通过 thumbnailUrl       │                 │    │
│  │        找到 DOM 中的 <img>     │                 │    │
│  │     b. 向上找 .overlay-container                │    │
│  │     c. 定位原生下载按钮        │                 │    │
│  │     d. button.click() 触发     │                 │    │
│  │     e. 等待 postMessage        ◄─── GBD_IMAGE   │    │
│  │        返回 dataUrl                 _CAPTURED   │    │
│  │     f. 发送到 Background       │                 │    │
│  │  3. 通知 Background 关闭       │                 │    │
│  │     suppress                   │                 │    │
│  └─────────────────────────┬───────────────────────┘    │
│                            │ chrome.runtime             │
│                            │ .sendMessage               │
├────────────────────────────┼────────────────────────────┤
│ Service Worker (Background)▼                            │
│                                                         │
│  src/background/index.ts                                │
│  ┌─────────────────────────────────────────────────┐    │
│  │ processAndDownload(dataUrl, filename):           │    │
│  │  1. dataUrl → blob                              │    │
│  │  2. removeWatermarkFromBlob(blob) 去水印         │    │
│  │  3. blob → processedDataUrl                     │    │
│  │  4. chrome.downloads.download() 保存文件         │    │
│  │                                                 │    │
│  │ 原生下载抑制 (chrome.downloads.onCreated):       │    │
│  │  - suppress 开启时，自动取消非本插件发起的       │    │
│  │    blob: 下载，防止产生重复文件                  │    │
│  └─────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

### 3.3 关键文件

| 文件 | 运行环境 | 职责 |
|------|---------|------|
| `public/download-interceptor.js` | Main World | Patch fetch 捕获原图 blob |
| `src/content/index.ts` | Isolated World | UI 面板 + 编排下载流程 |
| `src/background/index.ts` | Service Worker | 水印去除 + 文件保存 + 原生下载抑制 |

### 3.4 跨 World 通信机制

Content Script (Isolated World) 和 Interceptor (Main World) 之间不能直接调用函数，通过两个通道通信：

| 方向 | 机制 | 用途 |
|------|------|------|
| Main → Content | `window.postMessage({ type: 'GBD_IMAGE_CAPTURED' })` | 传回捕获的图片数据 |
| Content → Background | `chrome.runtime.sendMessage({ type: 'SUPPRESS_DOWNLOADS' })` | 控制原生下载抑制 |
| Content → Background | `chrome.runtime.sendMessage({ type: 'DOWNLOAD_IMAGE' })` | 发送 dataUrl 做去水印+保存 |

Main → Content 使用 `postMessage`（跨 isolated/main world 通信的唯一可行方式）。Content → Background 使用标准的 `chrome.runtime.sendMessage`。

## 4. 原生下载抑制机制的演进

在开发过程中，「如何抑制 Gemini 页面自身触发的 blob: 下载」经历了三次迭代，最终才找到可靠的方案。这段历程反映了 Chrome 扩展跨 World 通信的种种限制。

### 4.1 第一次尝试：Main World 中 Patch `HTMLAnchorElement.prototype.click` + `CustomEvent` 控制

**思路**：在 main world 的 `download-interceptor.js` 中同时做两件事：
1. Patch `HTMLAnchorElement.prototype.click`，拦截所有 `blob:` 链接的 `.click()` 调用
2. Content Script 通过 `document.dispatchEvent(new CustomEvent('gbd-control', { detail: { suppress: true } }))` 发送控制信号，通知 main world 何时开启/关闭拦截

**失败原因**：

`CustomEvent.detail` **无法跨 isolated/main world 传递**。Chrome 的 isolated world 和 main world 虽然共享同一个 DOM，但拥有各自独立的 JavaScript 上下文。当 content script 创建一个 `CustomEvent` 并在 DOM 上 dispatch 时，main world 收到的事件对象的 `.detail` 属性始终为 `null`。

这是 Chrome 的安全设计，防止 isolated world 中的对象引用泄漏到 main world。具体原因：
- `CustomEvent` 的 `detail` 属性存储的是一个 JavaScript 对象引用
- Isolated world 和 main world 拥有各自独立的 JS 堆（heap）
- 跨 world 时，Chrome 不会自动序列化/克隆 `detail` 中的对象，而是直接将其置为 `null`
- 这与 `window.postMessage` 不同 —— `postMessage` 使用结构化克隆算法（Structured Clone Algorithm）自动序列化消息数据

**关键教训**：isolated world → main world 传递数据只能用 `window.postMessage`，不能用 `CustomEvent.detail`。

### 4.2 第二次尝试：Main World 中 Patch `HTMLAnchorElement.prototype.click` + `postMessage` 控制

**思路**：既然 `CustomEvent.detail` 不行，改用 `window.postMessage` 传递控制信号。Content script 发送 `postMessage({ type: 'GBD_SUPPRESS', suppress: true })`，main world 监听并据此控制 anchor click patch 的开关。

**失败原因**：

**`HTMLAnchorElement.prototype.click` 本身就不可靠。** Gemini 页面最终执行下载的方式并不一定是调用 `anchor.click()`。实际上有多种方式可以触发 `<a>` 元素的下载：

```javascript
// 方式 1: 直接调用 .click()（我们 patch 的）
anchor.click();

// 方式 2: 通过 dispatchEvent 触发（绕过 prototype patch）
anchor.dispatchEvent(new MouseEvent('click', { bubbles: true }));

// 方式 3: 直接设置 location（完全绕过 DOM）
window.location.href = blobUrl;

// 方式 4: 使用 Navigation API
navigation.navigate(blobUrl);
```

经过抓包分析，Gemini 的前端代码在完成 fetch 获取图片 blob 后，创建一个 `<a>` 元素设置 `href` 为 `blob:` URL 和 `download` 属性，然后触发点击。但具体是 `.click()` 还是 `dispatchEvent(new MouseEvent('click'))` 取决于 Angular 内部实现，而且不同版本可能不同。

即使我们同时 patch `.click()` 和监听 document 上的 `click` 事件冒泡：
- `dispatchEvent` 触发的事件在脱离 DOM 的元素上不会冒泡
- Gemini 可能创建一个临时 `<a>` 元素，不插入 DOM，直接 click 后丢弃

**关键教训**：在 main world 中用 JS patch 方式拦截浏览器下载本质上是一种"尝试预测页面所有可能行为"的竞赛（race），永远无法做到 100% 可靠。

### 4.3 最终方案：Background 层 `chrome.downloads.onCreated`

**思路**：放弃在页面 JS 层面拦截，转而在浏览器 API 层面拦截。

```typescript
// background/index.ts
let suppressNativeDownloads = false;
const ownDownloadIds = new Set<number>();

chrome.downloads.onCreated.addListener((item) => {
    if (suppressNativeDownloads && !ownDownloadIds.has(item.id) && item.url.startsWith('blob:')) {
        chrome.downloads.cancel(item.id);
        chrome.downloads.erase({ id: item.id });
    }
});
```

**为什么这是可靠的**：

1. **浏览器级别 API**：`chrome.downloads.onCreated` 是 Chrome 扩展 API，在浏览器进程（browser process）中运行，不依赖页面 JS 上下文。无论页面使用什么方式触发下载（`anchor.click()`、`dispatchEvent`、`window.location`、`Navigation API`），只要产生了下载行为，这个事件都会触发。

2. **精确识别**：通过 `item.url.startsWith('blob:')` 精确匹配 Gemini 的 blob 下载（Gemini 先 fetch 图片到内存，再创建 blob: URL 触发下载），同时不影响其他正常下载。

3. **防误杀**：通过 `ownDownloadIds` Set 追踪本插件自己发起的下载 ID，确保不会取消自己的下载。流程：
   - `chrome.downloads.download()` 的回调立即将 `downloadId` 加入 `ownDownloadIds`
   - `onCreated` 监听器检查 `ownDownloadIds` 跳过自己的下载
   - 下载完成/失败后从 `ownDownloadIds` 中移除

4. **时序窗口精确控制**：Content script 在开始批量下载前发送 `SUPPRESS_DOWNLOADS: true`，完成后发送 `SUPPRESS_DOWNLOADS: false`。抑制窗口仅在批量下载期间开启，不影响用户的正常下载行为。

**通信路径**：

```
Content Script ──chrome.runtime.sendMessage──► Background
  { type: 'SUPPRESS_DOWNLOADS', suppress: true }

Background 设置 suppressNativeDownloads = true

  ... 批量下载期间 ...
  页面 JS 触发 blob: 下载 → chrome.downloads.onCreated → cancel + erase

Content Script ──chrome.runtime.sendMessage──► Background
  { type: 'SUPPRESS_DOWNLOADS', suppress: false }
```

### 4.4 三种方案对比

| 维度 | CustomEvent 控制 | postMessage 控制 | chrome.downloads.onCreated |
|------|-----------------|-----------------|---------------------------|
| 拦截层面 | 页面 JS (main world) | 页面 JS (main world) | 浏览器进程 (background) |
| 信号传递 | CustomEvent.detail | window.postMessage | chrome.runtime.sendMessage |
| 可靠性 | ❌ detail 跨 world 丢失 | ❌ anchor patch 不可靠 | ✅ 浏览器级别，无法绕过 |
| 适用范围 | 仅 `.click()` 调用 | 仅 `.click()` 调用 | 任何下载触发方式 |
| 误杀风险 | 需要 suppress 标志 | 需要 suppress 标志 | 通过 ownDownloadIds 防误杀 |
| 状态 | 已否定 | 已否定 | **当前方案** |

## 5. 模拟点击与 `isTrusted` 深度分析

### 5.1 当前机制

整个下载流程的触发依赖 `button.click()` ——— 在 content script 中找到 Gemini 页面的原生 "Download full size image" 按钮，调用其 `.click()` 方法。

```typescript
// content/index.ts
function clickAndWaitForBlob(button: HTMLButtonElement, timeoutMs = 30000): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
            pendingBlobResolve = null;
            reject(new Error('等待原生下载响应超时'));
        }, timeoutMs);

        pendingBlobResolve = (dataUrl: string) => {
            clearTimeout(timer);
            resolve(dataUrl);
        };

        button.click();  // 产生 isTrusted: false 的事件
    });
}
```

`button.click()` 产生的 `click` 事件的 `isTrusted` 属性为 `false`，因为它不是由真实的用户输入设备（鼠标、键盘、触摸屏）产生的。

### 5.2 为什么 `isTrusted` 无法伪造

`isTrusted` 是 DOM 事件对象的一个**只读属性**，由浏览器内核（Blink 引擎）在创建事件时设置。根据 W3C UI Events 规范和 Mozilla Bug 637248 的讨论：

- `isTrusted` 属性是 **unforgeable** 的——即使通过 `Object.defineProperty` 也无法覆盖
- 它由 C++ 层的事件构造函数设置，JavaScript 层面没有任何手段可以将其改为 `true`
- 这是浏览器的安全边界：确保网页 JS 能区分真实用户操作和程序化触发

```javascript
const event = new MouseEvent('click');
console.log(event.isTrusted); // false —— 永远如此

// 即使尝试覆盖也无效
Object.defineProperty(event, 'isTrusted', { value: true });
console.log(event.isTrusted); // 依然是 false
```

### 5.3 Gemini 当前的 `isTrusted` 处理

**经实测验证，Gemini 目前不校验 `isTrusted`。** `button.click()` 成功触发了完整的 RPC 调用链（c8o8Fe batchexecute → 签名 URL → 重定向 → 原始 PNG），下载流程正常完成。

这与 Angular 框架的事件处理机制有关。Angular 使用 Zone.js 对事件进行代理，其事件处理管道不检查 `isTrusted`——Zone.js 关注的是事件的类型和目标元素，而非其来源。Angular 的 click 事件绑定（如 `(click)="download()"`）对 trusted 和 untrusted 事件一视同仁。

### 5.4 行业先例：模拟点击是浏览器扩展的标准实践

`button.click()` 在浏览器扩展生态中是**被广泛接受的标准做法**。以下是使用此技术的知名扩展：

| 扩展 | 用户量 | 模拟点击用途 |
|------|-------|-------------|
| **Tampermonkey / Greasemonkey** | 1000 万+ | 用户脚本频繁使用 `.click()` 自动化页面交互 |
| **Automa** | 50 万+ | 浏览器自动化工具，核心功能即模拟点击 |
| **UI.Vision RPA** | 30 万+ | 录制和回放用户操作，`.click()` 是基础 API |
| **iMacros** | 10 万+ | 经典浏览器自动化插件，20+ 年历史 |
| **Selenium IDE** | 10 万+ | 官方 Selenium 浏览器扩展版本 |
| **DownThemAll** | 历史 FF 下载管理器 | 自动触发下载链接的点击 |

**Greasemonkey Issue #2301** 的讨论明确指出：`isTrusted` 属性是 unforgeable 的，扩展开发者只能使用 `.click()` 这样的程序化触发方式，而绝大多数网站不检查此属性。这是浏览器扩展生态的既定事实（established fact），而非漏洞或 hack。

### 5.5 `isTrusted` 的实际风险评估

**Google 在 Gemini 上添加 `isTrusted` 检查的可能性较低，原因：**

1. **影响辅助技术**：屏幕阅读器、语音控制软件等辅助功能工具也会生成 `isTrusted: false` 的事件。如果 Gemini 检查 `isTrusted`，会破坏无障碍访问。
2. **Angular 框架惯例**：Angular 生态系统中几乎不存在检查 `isTrusted` 的实践。Angular Material、CDK 等官方库的组件测试全部使用 `.click()` 触发事件。
3. **测试基础设施**：Google 自己的测试框架（如 Webdriver、Puppeteer）在不使用 CDP 协议的模式下也会产生 untrusted 事件。Puppeteer 的 `page.click()` 虽然通过 CDP 发送 trusted input event，但其 `element.click()` 等方法同样产生 untrusted 事件。

**但这不意味着风险为零。** Google 未来可能出于安全或防滥用考虑添加检查。如果发生，可用的降级方案：

| 降级方案 | 原理 | 代价 |
|---------|------|------|
| `chrome.debugger` API | 通过 CDP 注入 trusted input event | 需要 `debugger` 权限；Chrome 会在页面顶部显示 "正在调试" 提示条 |
| Main world hook Angular 服务 | 在 main world 中找到 Angular 的下载服务实例，直接调用内部方法 | 高度依赖 Angular 内部实现；混淆后难以定位 |
| 自行构造 RPC | 绕过 UI，直接发送 `c8o8Fe` 请求 | 图片 token 获取是核心难题（见下文） |

## 6. 图片 Token 获取：鸡生蛋问题的深度分析

### 6.1 核心矛盾

获取原图的唯一途径是构造 `c8o8Fe` RPC 请求，而该请求需要**图片 token**（如 `$AedXnj...`）。这个 token 存储在 Angular 组件的内存中，无法从 DOM 或网络请求中直接获取。

这形成了一个**鸡生蛋问题**：
- **要下载原图**，需要图片 token 来构造 RPC 请求
- **要获取图片 token**，需要从 Angular 组件内存中提取
- **要访问 Angular 组件内存**，需要在 main world 中获取组件实例
- **Angular 生产模式不暴露组件实例**

### 6.2 从网络请求中提取 token？

一个直觉是：图片 token 一定在某次网络请求的响应中出现过（Gemini 服务端生成图片后，一定将 token 发给了前端）。那么能否通过拦截网络请求来捕获这些 token？

**理论上可以，但实践中极其困难：**

1. **token 的传输位置**：图片 token 出现在 Gemini 初始加载或流式响应的 batchexecute 响应中，嵌套在多层 JSON 和 protobuf 编码的数据结构里。需要逆向整个响应格式才能提取。

2. **请求拦截的两种途径**：

   | 拦截位置 | API | 能力 | 限制 |
   |---------|-----|------|------|
   | Background (Service Worker) | `chrome.webRequest` / `chrome.declarativeNetRequest` | 可拦截所有网络请求的 header 和 URL | MV3 中 `declarativeNetRequest` 是声明式的，不能读取响应体；`webRequest` 在 MV3 中受限 |
   | Main World (页面上下文) | 通过 patch `window.fetch` 或 `XMLHttpRequest` | 可以读取请求和响应的完整内容 | 需要注入 main world 脚本；Gemini 使用的 Streaming RPC 响应格式复杂 |

3. **Gemini 的响应格式**：batchexecute 的响应不是标准 JSON，而是 Google 特有的 JSPB（JavaScript Protocol Buffers）序列化格式的变体，混合了数组嵌套和字符串转义。解析这种格式需要深入逆向 Gemini 前端代码，而且格式随时可能变更。

4. **token 与图片的关联**：即使成功提取了所有 token，还需要建立 token → 具体图片的映射关系。一次会话中可能生成多张图片，每张图片有不同的 token，需要准确匹配。

**结论**：从网络请求中提取 token 虽然理论可行，但工程复杂度远超收益，且维护成本极高（每次 Gemini 更新响应格式都可能导致 parser 失效）。

### 6.3 为什么模拟点击是当前最优解

模拟点击方案的核心优势在于**完全绕过了 token 获取问题**：

```
模拟点击流程:
button.click()
  → Angular 事件处理器
  → Angular 从内存中读取 token（我们不需要知道 token 是什么）
  → Angular 构造 c8o8Fe RPC 请求（我们不需要知道请求格式）
  → 服务端返回签名 URL（我们不需要知道 URL 是如何签名的）
  → fetch 重定向链（我们在这里拦截最终的图片 blob）
```

通过让 Gemini 页面自身的 JS 完成所有从 token 读取到 RPC 调用的工作，我们**将整个复杂的认证和请求链路视为黑盒**，只在最终产物（原始 PNG blob）出现时将其截获。这意味着：

- 不需要逆向 Angular 内部数据结构
- 不需要解析 JSPB/protobuf 响应格式
- 不需要管理 CSRF token、会话 ID 等认证参数
- Gemini 前端更新 RPC 格式时，只要下载按钮和 fetch 行为不变，插件就不需要改动

## 7. 请求拦截位置的选择：Main World vs Background

### 7.1 两种拦截位置的能力对比

| 维度 | Background (chrome.webRequest) | Main World (fetch/XHR patch) |
|------|-------------------------------|------------------------------|
| **拦截时机** | 请求发出前 / 响应到达前 | 请求调用时 / 响应返回后 |
| **读取请求体** | ✅ `onBeforeRequest` (MV2) / 有限 (MV3) | ✅ 完全访问 |
| **读取响应体** | ❌ MV3 `declarativeNetRequest` 不支持 | ✅ 完全访问（`response.clone().blob()`）|
| **修改请求 Header** | ✅ `declarativeNetRequest` 支持 | ✅ 通过 patch 修改 |
| **跨域请求** | ✅ 有 `host_permissions` 即可 | ❌ 受页面 CORS 限制 |
| **对页面 JS 的影响** | 无——完全独立于页面 | 有——修改了页面的全局对象 |
| **被页面检测** | 不会 | 可能（页面可检查 fetch 是否被 patch） |

### 7.2 为什么图片 blob 拦截选在 Main World

我们需要**读取响应体**（图片 blob 数据），而 MV3 的 Background Service Worker 使用 `declarativeNetRequest`，这是一个**声明式 API**，只能修改 header、重定向或阻止请求，**无法读取或修改响应体**。

`chrome.webRequest` 在 MV3 中虽然仍可用，但能力受限（不再支持 blocking 模式的 `onBeforeRequest`），且不能直接获取响应 body。

因此，在 main world 中 patch `window.fetch` 是**唯一能够在不依赖额外权限的前提下获取图片响应体**的方式。

### 7.3 为什么 CORS 规则放在 Background

虽然图片 blob 拦截在 main world，但 CORS header 的修改通过 `declarativeNetRequest` 在 background 层完成：

```json
// public/rules.json
[{
  "id": 1,
  "action": {
    "type": "modifyHeaders",
    "responseHeaders": [
      { "header": "Access-Control-Allow-Origin", "operation": "set", "value": "*" }
    ]
  },
  "condition": {
    "urlFilter": "||lh3.googleusercontent.com",
    "resourceTypes": ["xmlhttprequest"]
  }
}]
```

这是因为页面中的 fetch 请求受 CORS 限制。Gemini 的下载重定向链（`gg-dl` → `rd-gg-dl`）可能跨域，如果没有正确的 CORS header，浏览器会拦截响应。`declarativeNetRequest` 擅长这类 header 修改操作。

### 7.4 职责分工总结

| 需求 | 实现位置 | 原因 |
|------|---------|------|
| 拦截图片 blob | Main World (fetch patch) | 需要读取响应体 |
| CORS header 修改 | Background (declarativeNetRequest) | 声明式 API 擅长 header 操作 |
| 抑制原生下载 | Background (chrome.downloads.onCreated) | 浏览器级别 API，无法被页面绕过 |
| 水印去除 + 保存 | Background (Service Worker) | 有完整的 API 权限 |

## 8. DOM 结构与图片识别

### 8.1 Gemini 生成图 vs 用户参考图

```html
<!-- Gemini 生成的图片 (应下载) -->
<single-image class="generated-image large">
  <div class="overlay-container">
    <button class="image-button">
      <img src="https://lh3...googleusercontent.com/gg/AMW1TP...=s1024-rj">
    </button>
    <div class="generated-image-controls">
      <download-generated-image-button>
        <button data-test-id="download-generated-image-button"
                aria-label="Download full size image">
        </button>
      </download-generated-image-button>
    </div>
  </div>
</single-image>

<!-- 用户上传的参考图 (应排除) -->
<user-query-file-carousel>
  <user-query-file-preview>
    <button class="preview-image-button">
      <img src="https://lh3...googleusercontent.com/gg/AMW1TP...">
    </button>
  </user-query-file-preview>
</user-query-file-carousel>
```

### 8.2 识别规则

1. **排除**：位于 `user-query-file-preview` 或 `user-query-file-carousel` 内的图片（用户上传的参考图）
2. **包含**：位于 `button.image-button` 或 `.overlay-container` 内的图片
3. **包含**：URL 匹配 `/gg/`、`/gg-dl/`、`/rd-gg/`、`/aip-dl/` 路径模式
4. **备选**：附近有 "Download full size image" 按钮且图片尺寸 >= 120px

**注意**：用户上传的参考图 URL 也可能匹配 `/gg/` 路径模式（它们同样通过 Google CDN 托管），因此**必须在 URL 匹配前先做容器排除检查**。

### 8.3 下载按钮定位

从 `<img>` 元素出发定位对应的原生下载按钮：

```
<img> → closest('.overlay-container') → querySelector('button[data-test-id="download-generated-image-button"]')
```

## 9. 已知限制与风险

### 9.1 `button.click()` 与 `isTrusted`

详见第 5 节的深度分析。

**现状**：经实测，Gemini 目前不校验 `isTrusted`，下载流程正常触发。

**风险等级**：低。添加 `isTrusted` 检查会破坏辅助技术和 Google 自身的测试基础设施。

### 9.2 数据传输大小

原始图片 ~7MB，转为 base64 dataURL 后约 ~9.3MB。通过 `postMessage` 和 `chrome.runtime.sendMessage` 传输大 dataURL 可能在极端情况下出现性能问题。

**缓解措施**：逐张下载（非并发），每张处理完毕后再处理下一张。

### 9.3 页面结构依赖

方案依赖以下 DOM 结构和选择器，Gemini 前端更新后可能需要适配：
- `.overlay-container` 容器
- `button[data-test-id="download-generated-image-button"]` 下载按钮
- `user-query-file-preview` / `user-query-file-carousel` 用户参考图容器
- `single-image.generated-image` 生成图容器

### 9.4 Fetch Patch 的兼容性

拦截器 patch 了 `window.fetch`，需要在页面自身的 JS 加载前注入。当前通过 content script 在加载时注入 `<script src>` 标签实现。

潜在风险：
- 如果页面有 Service Worker 缓存了 fetch 请求，可能绕过我们的 patch
- 页面可以通过比较 `window.fetch === nativeFetch` 检测 patch（但 Gemini 目前没有这样做）
- 如果页面在我们注入前就保存了原始 `fetch` 引用，我们的 patch 对这些调用无效

### 9.5 抑制窗口的时序风险

`SUPPRESS_DOWNLOADS` 的开/关之间存在一个时间窗口。如果用户在此窗口内手动触发了一个 blob: 下载（非常罕见），该下载会被误取消。

**缓解措施**：抑制窗口尽可能短（仅在批量下载期间），且只匹配 `blob:` 协议的下载。

## 10. 方案对比总结

| 方案 | 优点 | 缺点 | 状态 |
|------|------|------|------|
| URL 后缀改写 (`=s0`) | 实现简单 | **无法获取原图**（token 不同） | 已否定 |
| 自行构造 RPC 请求 | 不依赖 UI 交互 | 图片 token 无法从 DOM 获取；协议易变；响应格式复杂 | 未采用 |
| 从网络请求提取 token | 不依赖模拟点击 | JSPB 格式逆向困难；token-图片映射复杂；维护成本极高 | 分析后否定 |
| 拦截原生下载流程 | 复用页面已有逻辑；获取真正的原图 | 依赖 DOM 结构；`isTrusted` 理论风险（实际极低） | **当前方案** |
