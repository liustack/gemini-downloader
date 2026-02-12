/**
 * Reverse alpha blending to recover original pixels beneath the watermark.
 *
 * Gemini compositing formula:
 *   watermarked = alpha * 255 + (1 - alpha) * original
 *
 * Solving for original:
 *   original = (watermarked - alpha * 255) / (1 - alpha)
 */

const ALPHA_THRESHOLD = 0.002;
const MAX_ALPHA = 0.99;
const LOGO_VALUE = 255;

export interface WatermarkPosition {
    x: number;
    y: number;
    size: number;
}

export function removeWatermark(
    imageData: ImageData,
    alphaMap: Float32Array,
    position: WatermarkPosition,
): void {
    const { x, y, size } = position;
    const imgWidth = imageData.width;
    const imgHeight = imageData.height;
    const data = imageData.data;

    for (let row = 0; row < size; row++) {
        const py = y + row;
        if (py < 0 || py >= imgHeight) continue;

        for (let col = 0; col < size; col++) {
            const px = x + col;
            if (px < 0 || px >= imgWidth) continue;

            const alpha = Math.min(alphaMap[row * size + col], MAX_ALPHA);
            if (alpha < ALPHA_THRESHOLD) continue;

            const oneMinusAlpha = 1.0 - alpha;
            const imgIdx = (py * imgWidth + px) * 4;

            for (let c = 0; c < 3; c++) {
                const watermarked = data[imgIdx + c];
                const original = (watermarked - alpha * LOGO_VALUE) / oneMinusAlpha;
                data[imgIdx + c] = Math.max(0, Math.min(255, Math.round(original)));
            }
        }
    }
}
