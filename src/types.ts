export interface PreviewRect {
    x: number;
    y: number;
    width: number;
    height: number;
    dpr: number;
}

export type SourceSite = 'gemini' | 'notebooklm';
export type WatermarkMode = 'none' | 'gemini' | 'notebooklm';

export interface ImageInfo {
    id: number;
    thumbnailUrl: string;
    fullSizeUrl: string;
    selected: boolean;
    previewRect?: PreviewRect;
    title?: string;
    sourceSite?: SourceSite;
    artifactId?: string;
}

export type MessageType =
    | { type: 'TOGGLE_PANEL' }
    | { type: 'OPEN_PANEL' }
    | { type: 'DOWNLOAD_IMAGE'; dataUrl: string; filename: string }
    | {
          type: 'DOWNLOAD_IMAGE_URL';
          imageUrl: string;
          filename: string;
          watermarkMode?: WatermarkMode;
          // Backward compatibility with older callers.
          removeWatermark?: boolean;
      }
    | { type: 'SUPPRESS_DOWNLOADS'; suppress: boolean };
