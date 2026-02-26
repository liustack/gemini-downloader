import type { ImageInfo } from '../../types';
import type { DownloadDispatcher, SiteAdapter } from './types';
import { preloadLazyContent, sleep } from './viewport';

const ARTIFACT_BUTTON_SELECTOR = 'button.artifact-button-content';
const ARTIFACT_TITLE_SELECTOR = '.artifact-title';
const ARTIFACT_ICON_SELECTOR = '.artifact-icon';
const ARTIFACT_VIEWER_SELECTOR = '.artifact-viewer-container-dialog';
const ARTIFACT_MODAL_CLOSE_SELECTOR = 'button[aria-label="Close"]';
const ARTIFACT_IMAGE_SELECTOR =
    'infographic-viewer img, .artifact-content img[src*="/notebooklm/"], .artifact-content img[src*="/rd-notebooklm/"]';

const INFOGRAPHIC_DESCRIPTION_PATTERN = /infographic|信息图/i;
const INFOGRAPHIC_ICON_KEY = 'stacked_bar_chart';

function decodeBase64Url(input: string): string {
    const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    return atob(padded);
}

function extractArtifactId(button: HTMLButtonElement): string {
    const jslog = button.getAttribute('jslog') ?? '';
    const match = jslog.match(/;0:([A-Za-z0-9_\-=+/]+)/);
    if (!match) {
        return '';
    }

    try {
        const decoded = decodeBase64Url(match[1]);
        const parsed = JSON.parse(decoded);
        const artifactId = parsed?.[0]?.[1];
        return typeof artifactId === 'string' ? artifactId : '';
    } catch {
        return '';
    }
}

function normalizeTitle(rawTitle: string): string {
    return rawTitle
        .replace(/\s+/g, ' ')
        .replace(/more_vert/gi, '')
        .replace(/stacked_bar_chart/gi, '')
        .trim();
}

function extractArtifactTitle(button: HTMLButtonElement, fallbackIndex: number): string {
    const titleElement = button.querySelector<HTMLElement>(ARTIFACT_TITLE_SELECTOR);
    const titleText = normalizeTitle(titleElement?.textContent ?? '');
    if (titleText) {
        return titleText;
    }

    const fullText = normalizeTitle(button.innerText || button.textContent || '');
    if (fullText) {
        return fullText;
    }

    return `信息图_${fallbackIndex + 1}`;
}

function isInfographicButton(button: HTMLButtonElement): boolean {
    const description = button.getAttribute('aria-description') || '';
    if (INFOGRAPHIC_DESCRIPTION_PATTERN.test(description)) {
        return true;
    }

    const iconText = (button.querySelector(ARTIFACT_ICON_SELECTOR)?.textContent || '').trim().toLowerCase();
    if (iconText === INFOGRAPHIC_ICON_KEY) {
        return true;
    }

    return (button.innerText || '').toLowerCase().includes(INFOGRAPHIC_ICON_KEY);
}

function getInfographicButtons(): HTMLButtonElement[] {
    return Array.from(document.querySelectorAll<HTMLButtonElement>(ARTIFACT_BUTTON_SELECTOR)).filter(
        isInfographicButton,
    );
}

async function waitFor<T>(
    resolver: () => T | null | undefined | false,
    timeoutMs: number,
    intervalMs = 90,
): Promise<T> {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
        const value = resolver();
        if (value) {
            return value;
        }

        await sleep(intervalMs);
    }

    throw new Error('等待页面元素超时');
}

async function closeArtifactViewerIfOpen(): Promise<void> {
    const closeButton = document.querySelector<HTMLButtonElement>(ARTIFACT_MODAL_CLOSE_SELECTOR);
    if (!closeButton) {
        return;
    }

    closeButton.click();

    try {
        await waitFor(
            () => !document.querySelector(ARTIFACT_VIEWER_SELECTOR),
            6000,
            120,
        );
    } catch {
        // 忽略关闭等待失败，后续流程会重试
    }
}

async function openArtifactAndCaptureImageUrl(button: HTMLButtonElement): Promise<string> {
    button.scrollIntoView({ block: 'center', inline: 'nearest' });
    await sleep(70);
    button.click();

    const imageUrl = await waitFor(() => {
        const img = document.querySelector<HTMLImageElement>(ARTIFACT_IMAGE_SELECTOR);
        if (!img) {
            return '';
        }

        const src = img.currentSrc || img.src || '';
        if (!/googleusercontent\.com\/(?:rd-)?notebooklm\//i.test(src)) {
            return '';
        }

        return src;
    }, 20000, 120);

    await closeArtifactViewerIfOpen();
    return imageUrl;
}

function findArtifactButton(image: ImageInfo): HTMLButtonElement | null {
    const buttons = getInfographicButtons();
    if (buttons.length === 0) {
        return null;
    }

    if (image.artifactId) {
        const byId = buttons.find((button) => extractArtifactId(button) === image.artifactId);
        if (byId) {
            return byId;
        }
    }

    if (image.title) {
        const byTitle = buttons.find(
            (button) => extractArtifactTitle(button, 0) === image.title,
        );
        if (byTitle) {
            return byTitle;
        }
    }

    return buttons[image.id] ?? null;
}

function scanNotebookInfographics(): ImageInfo[] {
    const buttons = getInfographicButtons();
    const seen = new Set<string>();
    const images: ImageInfo[] = [];

    for (const button of buttons) {
        const artifactId = extractArtifactId(button);
        const title = extractArtifactTitle(button, images.length);
        const key = artifactId || title;

        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        images.push({
            id: images.length,
            thumbnailUrl: '',
            fullSizeUrl: key,
            selected: true,
            sourceSite: 'notebooklm',
            artifactId,
            title,
        });
    }

    return images;
}

export function createNotebookLmAdapter(): SiteAdapter {
    return {
        site: 'notebooklm',
        panelTitle: 'NotebookLM 信息图批量下载',
        entityName: 'NotebookLM 信息图',
        defaultPrefix: 'notebooklm',
        emptyMessage: '当前页面未检测到可下载的 NotebookLM 信息图',
        async prepareForScan(): Promise<void> {
            await closeArtifactViewerIfOpen();
            await preloadLazyContent({ maxContainers: 2, maxStepsPerContainer: 70, waitMs: 90 });
        },
        scanImages(): ImageInfo[] {
            return scanNotebookInfographics();
        },
        async beforeBatchDownload(): Promise<void> {
            await closeArtifactViewerIfOpen();
            await preloadLazyContent({ maxContainers: 2, maxStepsPerContainer: 100, waitMs: 90 });
        },
        async downloadImage(
            image: ImageInfo,
            filename: string,
            dispatcher: DownloadDispatcher,
        ): Promise<void> {
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    const button = findArtifactButton(image);
                    if (!button) {
                        throw new Error('未找到对应的信息图条目');
                    }

                    const imageUrl = await openArtifactAndCaptureImageUrl(button);
                    await dispatcher.downloadFromUrl(imageUrl, filename, {
                        watermarkMode: 'notebooklm',
                    });
                    return;
                } catch (error) {
                    if (attempt >= 2) {
                        throw error;
                    }

                    await closeArtifactViewerIfOpen();
                    await preloadLazyContent({ maxContainers: 2, maxStepsPerContainer: 80, waitMs: 90 });
                }
            }
        },
        async afterBatchDownload(): Promise<void> {
            await closeArtifactViewerIfOpen();
        },
    };
}
