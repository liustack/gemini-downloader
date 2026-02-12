/**
 * Compute per-pixel alpha values from a captured watermark reference image.
 *
 * The reference images (bg_48.png / bg_96.png) were captured on a pure-black
 * background, so pixel brightness directly maps to the watermark alpha:
 *   watermarked = alpha * 255 + (1 - alpha) * 0  →  alpha = pixel / 255
 */
export function calculateAlphaMap(imageData: ImageData): Float32Array {
    const { width, height, data } = imageData;
    const alphaMap = new Float32Array(width * height);

    for (let i = 0; i < alphaMap.length; i++) {
        const idx = i * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        alphaMap[i] = Math.max(r, g, b) / 255.0;
    }

    return alphaMap;
}
