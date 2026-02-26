import type { ImageInfo, WatermarkMode } from '../../types';

export type SupportedSite = 'gemini' | 'notebooklm';

export interface DownloadDispatcher {
    setSuppressDownload(suppress: boolean): void;
    downloadFromDataUrl(dataUrl: string, filename: string): Promise<void>;
    downloadFromUrl(
        imageUrl: string,
        filename: string,
        options?: { watermarkMode?: WatermarkMode },
    ): Promise<void>;
}

export interface SiteAdapter {
    readonly site: SupportedSite;
    readonly panelTitle: string;
    readonly entityName: string;
    readonly defaultPrefix: string;
    readonly emptyMessage: string;
    prepareForScan?(): Promise<void>;
    beforeBatchDownload?(dispatcher: DownloadDispatcher): Promise<void>;
    downloadImage(
        image: ImageInfo,
        filename: string,
        dispatcher: DownloadDispatcher,
    ): Promise<void>;
    afterBatchDownload?(dispatcher: DownloadDispatcher): Promise<void>;
    scanImages(): ImageInfo[];
}
