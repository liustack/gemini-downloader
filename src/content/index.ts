import type { ImageInfo } from '../types';

/**
 * Content Script: 扫描 Gemini 页面中的生成图片，并在页面内渲染下载面板
 */

console.log('[Gemini Batch Downloader] Content script injected');

const SIZE_SUFFIX_PATTERN = /=s\d+(?=[-?#]|$)/i;
const GOOGLE_USER_CONTENT_PATTERN = /googleusercontent\.com/i;
const GEMINI_PATH_PATTERN = /\/(rd-gg(?:-dl)?|gg-dl|aip-dl)\//i;
const MIN_IMAGE_EDGE = 120;
const DOWNLOAD_BUTTON_LABELS = [
    'Download full size image',
    '下载完整尺寸图片',
    '下载全尺寸图片',
    '下载图片',
];
const IMAGE_CONTAINER_SELECTOR = 'button.image-button, .overlay-container';
const PANEL_HOST_ID = 'gbd-panel-host';

type PanelStatus = 'idle' | 'loading' | 'ready' | 'error' | 'downloading' | 'done';

interface PanelState {
    visible: boolean;
    status: PanelStatus;
    images: ImageInfo[];
    prefix: string;
    progress: { completed: number; total: number };
    result: { succeeded: number; failed: number };
    errorMessage: string;
}

interface PanelElements {
    panel: HTMLDivElement;
    closeButton: HTMLButtonElement;
    status: HTMLDivElement;
    toolbar: HTMLDivElement;
    selectAll: HTMLInputElement;
    selectText: HTMLSpanElement;
    prefixInput: HTMLInputElement;
    grid: HTMLDivElement;
    progress: HTMLDivElement;
    progressFill: HTMLDivElement;
    progressText: HTMLSpanElement;
    result: HTMLDivElement;
    downloadButton: HTMLButtonElement;
}

const state: PanelState = {
    visible: false,
    status: 'idle',
    images: [],
    prefix: 'gemini',
    progress: { completed: 0, total: 0 },
    result: { succeeded: 0, failed: 0 },
    errorMessage: '',
};

let panelHost: HTMLDivElement | null = null;
let panelRoot: ShadowRoot | null = null;
let panelElements: PanelElements | null = null;
let refreshScheduled = false;
let renderScheduled = false;

function rewriteSizeToken(url: string, target: string): string {
    if (SIZE_SUFFIX_PATTERN.test(url)) {
        return url.replace(SIZE_SUFFIX_PATTERN, target);
    }

    if (!GOOGLE_USER_CONTENT_PATTERN.test(url)) {
        return url;
    }

    // 兜底：Gemini 资源无 size token 时直接追加 =s0
    if (GEMINI_PATH_PATTERN.test(url)) {
        const queryOrHashIndex = url.search(/[?#]/);
        if (queryOrHashIndex === -1) {
            return `${url}${target}`;
        }
        return `${url.slice(0, queryOrHashIndex)}${target}${url.slice(queryOrHashIndex)}`;
    }

    return url;
}

function toFullSizeUrl(url: string): string {
    return rewriteSizeToken(url, '=s0');
}

function getVisualEdge(img: HTMLImageElement): number {
    const rect = img.getBoundingClientRect();
    return Math.max(img.naturalWidth, img.naturalHeight, rect.width, rect.height);
}

function hasNearbyDownloadButton(img: HTMLImageElement): boolean {
    const container = img.closest('figure, div, article, button');
    if (!container) {
        return false;
    }

    return DOWNLOAD_BUTTON_LABELS.some((label) =>
        container.querySelector(`button[aria-label*="${label}"]`) !== null
    );
}

function isLikelyGeminiImage(img: HTMLImageElement, url: string): boolean {
    if (!url || url.startsWith('data:') || url.startsWith('blob:')) {
        return false;
    }

    if (img.closest(IMAGE_CONTAINER_SELECTOR)) {
        return true;
    }

    if (GEMINI_PATH_PATTERN.test(url)) {
        return true;
    }

    const hasGoogleContentHost = GOOGLE_USER_CONTENT_PATTERN.test(url);
    if (!hasGoogleContentHost && !hasNearbyDownloadButton(img)) {
        return false;
    }

    if (hasNearbyDownloadButton(img)) {
        return true;
    }

    return getVisualEdge(img) >= MIN_IMAGE_EDGE;
}

function collectImagesFromRoot(root: Document | ShadowRoot): HTMLImageElement[] {
    const images = Array.from(root.querySelectorAll('img'));
    const ownerDocument = root instanceof Document ? root : root.ownerDocument;
    const walker = ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);

    let currentNode = walker.nextNode();
    while (currentNode) {
        if (currentNode instanceof HTMLElement && currentNode.shadowRoot) {
            if (currentNode.id !== PANEL_HOST_ID) {
                images.push(...collectImagesFromRoot(currentNode.shadowRoot));
            }
        }
        currentNode = walker.nextNode();
    }

    return images;
}

function scanImages(): ImageInfo[] {
    const allImages = collectImagesFromRoot(document);
    const uniqueImages = new Map<
        string,
        { image: Omit<ImageInfo, 'id'>; score: number }
    >();

    for (const img of allImages) {
        if (panelRoot && img.getRootNode() === panelRoot) {
            continue;
        }

        const sourceUrl = img.currentSrc || img.src || '';
        if (!isLikelyGeminiImage(img, sourceUrl)) {
            continue;
        }

        const fullSizeUrl = toFullSizeUrl(sourceUrl);
        const score = getVisualEdge(img);
        const candidate = {
            thumbnailUrl: sourceUrl,
            fullSizeUrl,
            selected: true,
        };
        const existing = uniqueImages.get(fullSizeUrl);

        if (!existing || score > existing.score) {
            uniqueImages.set(fullSizeUrl, { image: candidate, score });
        }
    }

    const result = Array.from(uniqueImages.values()).map((entry, index) => ({
        id: index,
        ...entry.image,
    }));

    console.log(
        `[Gemini Batch Downloader] Scanned ${allImages.length} <img>, matched ${result.length} Gemini images`
    );

    return result;
}

function scheduleRender(): void {
    if (renderScheduled) {
        return;
    }

    renderScheduled = true;
    queueMicrotask(() => {
        renderScheduled = false;
        renderPanel();
    });
}

function ensurePanel(): void {
    if (panelElements) {
        return;
    }

    panelHost = document.getElementById(PANEL_HOST_ID) as HTMLDivElement | null;
    if (!panelHost) {
        panelHost = document.createElement('div');
        panelHost.id = PANEL_HOST_ID;
        document.documentElement.appendChild(panelHost);
    }

    panelRoot = panelHost.shadowRoot ?? panelHost.attachShadow({ mode: 'open' });
    panelRoot.innerHTML = `
      <style>
        :host { all: initial; }
        *, *::before, *::after { box-sizing: border-box; }
        .panel {
          position: fixed;
          top: 80px;
          right: 20px;
          width: 360px;
          max-height: calc(100vh - 120px);
          display: flex;
          flex-direction: column;
          background: #12192e;
          color: #e5ecff;
          border: 1px solid #27406f;
          border-radius: 12px;
          overflow: hidden;
          box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45);
          z-index: 2147483647;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        }
        .hidden { display: none !important; }
        .header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 12px 14px;
          background: linear-gradient(135deg, #15203f, #0f1a35);
          border-bottom: 1px solid #27406f;
        }
        .title { font-size: 14px; font-weight: 700; color: #63adff; }
        .close {
          background: transparent;
          border: none;
          color: #8ea6d4;
          font-size: 20px;
          line-height: 1;
          cursor: pointer;
        }
        .status {
          padding: 14px;
          font-size: 13px;
          color: #9cb2db;
          border-bottom: 1px solid #1f335a;
        }
        .toolbar {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 10px 14px;
          border-bottom: 1px solid #1f335a;
        }
        .toolbar label {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          font-size: 12px;
          color: #b9c7e8;
        }
        .toolbar input[type="checkbox"] {
          width: 14px;
          height: 14px;
          accent-color: #4a9eff;
        }
        .prefix {
          margin-left: auto;
          width: 140px;
          background: #0d1429;
          color: #e5ecff;
          border: 1px solid #2b477a;
          border-radius: 6px;
          padding: 6px 8px;
          font-size: 12px;
        }
        .grid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 8px;
          padding: 10px 14px;
          overflow: auto;
          max-height: 320px;
        }
        .card {
          position: relative;
          border: 2px solid transparent;
          border-radius: 8px;
          overflow: hidden;
          padding: 0;
          margin: 0;
          cursor: pointer;
          background: #0d1429;
          aspect-ratio: 3 / 4;
        }
        .card.selected {
          border-color: #4a9eff;
          box-shadow: 0 0 0 1px #4a9eff;
        }
        .card img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
          background: #0a1021;
        }
        .badge {
          position: absolute;
          top: 6px;
          right: 6px;
          background: rgba(10, 16, 33, 0.75);
          color: #e5ecff;
          font-size: 10px;
          border-radius: 999px;
          padding: 2px 6px;
        }
        .check {
          position: absolute;
          top: 6px;
          left: 6px;
          width: 18px;
          height: 18px;
          border-radius: 999px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: rgba(9, 16, 33, 0.72);
          color: #fff;
          font-size: 12px;
        }
        .progress {
          padding: 8px 14px;
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 11px;
          color: #9cb2db;
        }
        .bar {
          flex: 1;
          height: 4px;
          border-radius: 999px;
          background: #1b2c4f;
          overflow: hidden;
        }
        .fill {
          height: 100%;
          width: 0;
          background: linear-gradient(90deg, #4a9eff, #6d61ff);
          transition: width 0.2s ease;
        }
        .result {
          padding: 8px 14px;
          font-size: 12px;
          color: #b9c7e8;
        }
        .footer {
          padding: 10px 14px 14px;
          border-top: 1px solid #1f335a;
        }
        .download {
          width: 100%;
          border: none;
          border-radius: 10px;
          padding: 10px;
          font-size: 13px;
          font-weight: 700;
          color: #fff;
          background: linear-gradient(135deg, #4a9eff, #6d61ff);
          cursor: pointer;
        }
        .download:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
      </style>
      <div class="panel hidden" data-role="panel">
        <div class="header">
          <div class="title">Gemini 图片批量下载</div>
          <button class="close" type="button" data-role="close">×</button>
        </div>
        <div class="status" data-role="status"></div>
        <div class="toolbar hidden" data-role="toolbar">
          <label>
            <input type="checkbox" data-role="select-all" />
            <span data-role="select-text">全选 (0/0)</span>
          </label>
          <input class="prefix" type="text" data-role="prefix" placeholder="文件名前缀" />
        </div>
        <div class="grid hidden" data-role="grid"></div>
        <div class="progress hidden" data-role="progress">
          <div class="bar"><div class="fill" data-role="progress-fill"></div></div>
          <span data-role="progress-text"></span>
        </div>
        <div class="result hidden" data-role="result"></div>
        <div class="footer hidden" data-role="footer">
          <button class="download" type="button" data-role="download"></button>
        </div>
      </div>
    `;

    const queryRequired = <T extends Element>(selector: string): T => {
        const node = panelRoot?.querySelector<T>(selector);
        if (!node) {
            throw new Error(`Panel element not found: ${selector}`);
        }
        return node;
    };

    panelElements = {
        panel: queryRequired<HTMLDivElement>('[data-role="panel"]'),
        closeButton: queryRequired<HTMLButtonElement>('[data-role="close"]'),
        status: queryRequired<HTMLDivElement>('[data-role="status"]'),
        toolbar: queryRequired<HTMLDivElement>('[data-role="toolbar"]'),
        selectAll: queryRequired<HTMLInputElement>('[data-role="select-all"]'),
        selectText: queryRequired<HTMLSpanElement>('[data-role="select-text"]'),
        prefixInput: queryRequired<HTMLInputElement>('[data-role="prefix"]'),
        grid: queryRequired<HTMLDivElement>('[data-role="grid"]'),
        progress: queryRequired<HTMLDivElement>('[data-role="progress"]'),
        progressFill: queryRequired<HTMLDivElement>('[data-role="progress-fill"]'),
        progressText: queryRequired<HTMLSpanElement>('[data-role="progress-text"]'),
        result: queryRequired<HTMLDivElement>('[data-role="result"]'),
        downloadButton: queryRequired<HTMLButtonElement>('[data-role="download"]'),
    };

    panelElements.closeButton.addEventListener('click', () => {
        closePanel();
    });

    panelElements.prefixInput.value = state.prefix;
    panelElements.prefixInput.addEventListener('input', () => {
        state.prefix = panelElements?.prefixInput.value.trim() || 'gemini';
    });

    panelElements.selectAll.addEventListener('change', () => {
        const checked = panelElements?.selectAll.checked ?? false;
        state.images = state.images.map((image) => ({ ...image, selected: checked }));
        scheduleRender();
    });

    panelElements.grid.addEventListener('click', (event) => {
        if (state.status === 'downloading') {
            return;
        }

        const target = event.target as HTMLElement;
        const card = target.closest<HTMLButtonElement>('button[data-id]');
        if (!card) {
            return;
        }

        const id = Number(card.dataset.id ?? '-1');
        if (id < 0) {
            return;
        }

        state.images = state.images.map((image) =>
            image.id === id ? { ...image, selected: !image.selected } : image
        );
        scheduleRender();
    });

    panelElements.downloadButton.addEventListener('click', () => {
        startDownload();
    });
}

function renderGrid(elements: PanelElements): void {
    elements.grid.replaceChildren();

    for (const image of state.images) {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = `card ${image.selected ? 'selected' : ''}`;
        card.dataset.id = String(image.id);

        const img = document.createElement('img');
        img.src = image.thumbnailUrl;
        img.alt = `Image ${image.id + 1}`;
        img.loading = 'lazy';
        img.addEventListener('error', () => {
            if (img.src !== image.fullSizeUrl) {
                img.src = image.fullSizeUrl;
            }
        });

        const check = document.createElement('span');
        check.className = 'check';
        check.textContent = image.selected ? '✓' : '';

        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = `#${image.id + 1}`;

        card.append(img, check, badge);
        elements.grid.appendChild(card);
    }
}

function renderPanel(): void {
    if (!panelElements) {
        return;
    }

    const elements = panelElements;
    const selectedCount = state.images.filter((image) => image.selected).length;
    const allSelected = state.images.length > 0 && selectedCount === state.images.length;

    elements.panel.classList.toggle('hidden', !state.visible);

    if (!state.visible) {
        return;
    }

    elements.selectAll.checked = allSelected;
    elements.selectText.textContent = `全选 (${selectedCount}/${state.images.length})`;
    elements.prefixInput.value = state.prefix;

    if (state.status === 'loading') {
        elements.status.textContent = '正在检测 Gemini 图片...';
        elements.toolbar.classList.add('hidden');
        elements.grid.classList.add('hidden');
        elements.progress.classList.add('hidden');
        elements.result.classList.add('hidden');
        elements.downloadButton.disabled = true;
        elements.downloadButton.textContent = '下载选中 (0)';
        elements.downloadButton.parentElement?.classList.add('hidden');
        return;
    }

    if (state.status === 'error') {
        elements.status.textContent = state.errorMessage;
        elements.toolbar.classList.add('hidden');
        elements.grid.classList.add('hidden');
        elements.progress.classList.add('hidden');
        elements.result.classList.add('hidden');
        elements.downloadButton.disabled = true;
        elements.downloadButton.textContent = '下载选中 (0)';
        elements.downloadButton.parentElement?.classList.add('hidden');
        return;
    }

    elements.status.textContent = `已检测到 ${state.images.length} 张 Gemini 图片`;
    elements.toolbar.classList.remove('hidden');
    elements.grid.classList.remove('hidden');
    elements.downloadButton.parentElement?.classList.remove('hidden');

    renderGrid(elements);

    if (state.status === 'downloading') {
        const total = state.progress.total || 1;
        const percent = Math.max(
            0,
            Math.min(100, (state.progress.completed / total) * 100)
        );
        elements.progress.classList.remove('hidden');
        elements.progressFill.style.width = `${percent}%`;
        elements.progressText.textContent = `下载中 ${state.progress.completed}/${state.progress.total}`;
    } else {
        elements.progress.classList.add('hidden');
        elements.progressFill.style.width = '0%';
    }

    if (state.status === 'done') {
        elements.result.classList.remove('hidden');
        elements.result.textContent = `完成：成功 ${state.result.succeeded} 张，失败 ${state.result.failed} 张`;
    } else {
        elements.result.classList.add('hidden');
        elements.result.textContent = '';
    }

    elements.downloadButton.disabled =
        state.status === 'downloading' || selectedCount === 0;

    if (state.status === 'downloading') {
        elements.downloadButton.textContent = '下载中...';
    } else if (state.status === 'done') {
        elements.downloadButton.textContent = `重新下载 (${selectedCount})`;
    } else {
        elements.downloadButton.textContent = `下载选中 (${selectedCount})`;
    }
}

function refreshImages(): void {
    const nextImages = scanImages();

    if (nextImages.length === 0) {
        state.images = [];
        state.status = 'error';
        state.errorMessage = '当前页面未检测到 Gemini 生成的图片';
        scheduleRender();
        return;
    }

    const previousSelection = new Map(
        state.images.map((image) => [image.fullSizeUrl, image.selected])
    );

    state.images = nextImages.map((image) => ({
        ...image,
        selected: previousSelection.get(image.fullSizeUrl) ?? true,
    }));

    if (state.status !== 'downloading') {
        state.status = state.status === 'done' ? 'done' : 'ready';
        state.errorMessage = '';
    }

    scheduleRender();
}

function scheduleRefreshFromMutation(): void {
    if (!state.visible || state.status === 'downloading') {
        return;
    }

    if (refreshScheduled) {
        return;
    }

    refreshScheduled = true;
    window.setTimeout(() => {
        refreshScheduled = false;
        refreshImages();
    }, 200);
}

function openPanel(): void {
    ensurePanel();
    state.visible = true;
    state.status = 'loading';
    state.errorMessage = '';
    scheduleRender();
    refreshImages();
}

function closePanel(): void {
    state.visible = false;
    scheduleRender();
}

function togglePanel(): void {
    if (state.visible) {
        closePanel();
        return;
    }

    openPanel();
}

function startDownload(): void {
    if (state.status === 'downloading') {
        return;
    }

    const selectedImages = state.images.filter((image) => image.selected);
    if (selectedImages.length === 0) {
        return;
    }

    state.status = 'downloading';
    state.progress = { completed: 0, total: selectedImages.length };
    state.result = { succeeded: 0, failed: 0 };
    scheduleRender();

    chrome.runtime.sendMessage(
        {
            type: 'DOWNLOAD_IMAGES',
            images: selectedImages,
            prefix: state.prefix || 'gemini',
        },
        (
            response:
                | { type: string; succeeded: number; failed: number }
                | undefined
        ) => {
            if (chrome.runtime.lastError) {
                state.status = 'error';
                state.errorMessage = chrome.runtime.lastError.message || '下载失败';
                scheduleRender();
                return;
            }

            if (!response) {
                state.status = 'error';
                state.errorMessage = '下载请求失败：未收到响应';
                scheduleRender();
                return;
            }

            state.result = {
                succeeded: response.succeeded,
                failed: response.failed,
            };
            state.status = 'done';
            scheduleRender();
        }
    );
}

const observer = new MutationObserver(() => {
    scheduleRefreshFromMutation();
});

observer.observe(document.body ?? document.documentElement, {
    childList: true,
    subtree: true,
});

chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'TOGGLE_PANEL') {
        togglePanel();
        return false;
    }

    if (message.type === 'OPEN_PANEL') {
        openPanel();
        return false;
    }

    if (message.type === 'DOWNLOAD_PROGRESS' && state.status === 'downloading') {
        state.progress = {
            completed: message.completed,
            total: message.total,
        };
        scheduleRender();
    }

    return false;
});

console.log('[Gemini Batch Downloader] Panel bridge ready');
