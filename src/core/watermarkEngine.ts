import { calculateAlphaMap } from './alphaMap.ts';
import { removeWatermark, type WatermarkPosition } from './blendModes.ts';
import bg48Url from '../assets/bg_48.png';
import bg96Url from '../assets/bg_96.png';

interface WatermarkConfig {
    size: 48 | 96;
    marginRight: number;
    marginBottom: number;
}

function detectConfig(width: number, height: number): WatermarkConfig {
    if (width > 1024 && height > 1024) {
        return { size: 96, marginRight: 64, marginBottom: 64 };
    }
    return { size: 48, marginRight: 32, marginBottom: 32 };
}

function computePosition(
    imgWidth: number,
    imgHeight: number,
    config: WatermarkConfig,
): WatermarkPosition {
    return {
        x: imgWidth - config.marginRight - config.size,
        y: imgHeight - config.marginBottom - config.size,
        size: config.size,
    };
}

async function loadImageBitmap(url: string): Promise<ImageBitmap> {
    const response = await fetch(url);
    const blob = await response.blob();
    return createImageBitmap(blob);
}

function getImageData(bitmap: ImageBitmap): ImageData {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
}

const alphaMaps = new Map<number, Float32Array>();

async function getAlphaMap(size: 48 | 96): Promise<Float32Array> {
    const cached = alphaMaps.get(size);
    if (cached) return cached;

    const url = size === 48 ? bg48Url : bg96Url;
    const bitmap = await loadImageBitmap(url);
    const imageData = getImageData(bitmap);
    const alphaMap = calculateAlphaMap(imageData);
    alphaMaps.set(size, alphaMap);
    bitmap.close();
    return alphaMap;
}

/**
 * Remove Gemini watermark from an image blob.
 * Returns a new PNG blob with watermark removed.
 */
export async function removeWatermarkFromBlob(blob: Blob): Promise<Blob> {
    const bitmap = await createImageBitmap(blob);
    const { width, height } = bitmap;

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();

    const config = detectConfig(width, height);
    const position = computePosition(width, height, config);
    const alphaMap = await getAlphaMap(config.size);
    const imageData = ctx.getImageData(0, 0, width, height);

    removeWatermark(imageData, alphaMap, position);

    ctx.putImageData(imageData, 0, 0);
    return canvas.convertToBlob({ type: 'image/png' });
}
