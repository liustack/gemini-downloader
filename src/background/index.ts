/**
 * Background Service Worker: 处理面板切换、图片下载（fetch + 可选去水印 + 保存）
 */

import { removeWatermarkFromBlob } from '../core/watermarkEngine.ts';
import { removeNotebookLmWatermarkFromBlob } from '../core/notebooklmWatermarkEngine.ts';
import type { WatermarkMode } from '../types.ts';

const GEMINI_HOME_URL = 'https://gemini.google.com/';
const NOTEBOOKLM_HOME_URL = 'https://notebooklm.google.com/';

function isSupportedTab(tab: chrome.tabs.Tab): boolean {
    if (typeof tab.url !== 'string') {
        return false;
    }

    return tab.url.startsWith(GEMINI_HOME_URL) || tab.url.startsWith(NOTEBOOKLM_HOME_URL);
}

function sendPanelMessage(tabId: number, type: 'TOGGLE_PANEL' | 'OPEN_PANEL'): void {
    chrome.tabs.sendMessage(tabId, { type }, () => {
        if (chrome.runtime.lastError) {
            console.debug('[Banana Downloader] sendPanelMessage failed:', chrome.runtime.lastError.message);
        }
    });
}

chrome.action.onClicked.addListener((tab) => {
    if (tab.id && isSupportedTab(tab)) {
        sendPanelMessage(tab.id, 'TOGGLE_PANEL');
        return;
    }

    chrome.tabs.create({ url: GEMINI_HOME_URL }, (createdTab) => {
        if (!createdTab?.id) {
            return;
        }

        const listener = (tabId: number, changeInfo: { status?: string }) => {
            if (tabId !== createdTab.id || changeInfo.status !== 'complete') {
                return;
            }

            chrome.tabs.onUpdated.removeListener(listener);
            sendPanelMessage(createdTab.id!, 'OPEN_PANEL');
        };

        chrome.tabs.onUpdated.addListener(listener);
    });
});

let suppressNativeDownloads = false;
const ownDownloadIds = new Set<number>();

chrome.downloads.onCreated.addListener((item) => {
    if (suppressNativeDownloads && !ownDownloadIds.has(item.id) && item.url.startsWith('blob:')) {
        chrome.downloads.cancel(item.id);
        chrome.downloads.erase({ id: item.id });
    }
});

async function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}

function resolveWatermarkMode(
    watermarkMode: unknown,
    removeWatermarkLegacy?: unknown,
): WatermarkMode {
    if (
        watermarkMode === 'none' ||
        watermarkMode === 'gemini' ||
        watermarkMode === 'notebooklm'
    ) {
        return watermarkMode;
    }

    if (typeof removeWatermarkLegacy === 'boolean') {
        return removeWatermarkLegacy ? 'gemini' : 'none';
    }

    return 'gemini';
}

async function processBlob(blob: Blob, watermarkMode: WatermarkMode): Promise<Blob> {
    if (watermarkMode === 'none') {
        return blob;
    }

    if (watermarkMode === 'notebooklm') {
        return removeNotebookLmWatermarkFromBlob(blob);
    }

    return removeWatermarkFromBlob(blob);
}

async function saveBlobAsDownload(blob: Blob, filename: string): Promise<{ success: boolean; error?: string }> {
    const processedDataUrl = await blobToDataUrl(blob);

    return new Promise((resolve) => {
        chrome.downloads.download(
            { url: processedDataUrl, filename, conflictAction: 'uniquify' },
            (downloadId) => {
                if (chrome.runtime.lastError) {
                    resolve({ success: false, error: chrome.runtime.lastError.message });
                    return;
                }

                ownDownloadIds.add(downloadId);

                const listener = (delta: chrome.downloads.DownloadDelta) => {
                    if (delta.id !== downloadId) {
                        return;
                    }

                    if (delta.state?.current === 'complete') {
                        chrome.downloads.onChanged.removeListener(listener);
                        ownDownloadIds.delete(downloadId);
                        resolve({ success: true });
                    } else if (delta.state?.current === 'interrupted') {
                        chrome.downloads.onChanged.removeListener(listener);
                        ownDownloadIds.delete(downloadId);
                        resolve({ success: false, error: delta.error?.current });
                    }
                };

                chrome.downloads.onChanged.addListener(listener);
            },
        );
    });
}

async function processAndDownloadDataUrl(
    dataUrl: string,
    filename: string,
    watermarkMode: WatermarkMode,
): Promise<{ success: boolean; error?: string }> {
    const response = await fetch(dataUrl);
    const sourceBlob = await response.blob();
    const finalBlob = await processBlob(sourceBlob, watermarkMode);
    return saveBlobAsDownload(finalBlob, filename);
}

async function processAndDownloadImageUrl(
    imageUrl: string,
    filename: string,
    watermarkMode: WatermarkMode,
): Promise<{ success: boolean; error?: string }> {
    const response = await fetch(imageUrl, { credentials: 'include' });
    if (!response.ok) {
        throw new Error(`远程图片下载失败: ${response.status}`);
    }

    const sourceBlob = await response.blob();
    const finalBlob = await processBlob(sourceBlob, watermarkMode);
    return saveBlobAsDownload(finalBlob, filename);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'SUPPRESS_DOWNLOADS') {
        suppressNativeDownloads = !!message.suppress;
        return false;
    }

    if (message.type === 'DOWNLOAD_IMAGE') {
        const { dataUrl, filename } = message as {
            type: 'DOWNLOAD_IMAGE';
            dataUrl: string;
            filename: string;
        };

        processAndDownloadDataUrl(dataUrl, filename, 'gemini')
            .then(sendResponse)
            .catch((err) => sendResponse({ success: false, error: String(err) }));

        return true;
    }

    if (message.type === 'DOWNLOAD_IMAGE_URL') {
        const { imageUrl, filename, watermarkMode, removeWatermark } = message as {
            type: 'DOWNLOAD_IMAGE_URL';
            imageUrl: string;
            filename: string;
            watermarkMode?: WatermarkMode;
            removeWatermark?: boolean;
        };

        const mode = resolveWatermarkMode(watermarkMode, removeWatermark);

        processAndDownloadImageUrl(imageUrl, filename, mode)
            .then(sendResponse)
            .catch((err) => sendResponse({ success: false, error: String(err) }));

        return true;
    }

    return false;
});

console.log('[Banana Downloader] Background service worker loaded');
