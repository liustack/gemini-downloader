interface FillRegion {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    sampleY1: number;
    sampleY2: number;
}

interface DetectionRoi {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
}

interface ComponentStats {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    area: number;
    pixels: number[];
}

interface ColumnSamples {
    r: Uint8ClampedArray;
    g: Uint8ClampedArray;
    b: Uint8ClampedArray;
    a: Uint8ClampedArray;
}

const REFERENCE_WIDTH = 2752;
const REFERENCE_HEIGHT = 1536;
// NOTE: NotebookLM reference projects define watermark bbox in PDF-space points.
// Exported image pixels are effectively ~2x that coordinate system.
const WATERMARK_WIDTH = 230;
const WATERMARK_HEIGHT = 60;
const MARGIN_RIGHT = 10;
const MARGIN_BOTTOM = 10;
const SAMPLE_TOP_START = 20;
const SAMPLE_TOP_END = 4;

const DIFF_MIN_THRESHOLD = 18;
const DIFF_MAX_THRESHOLD = 52;
const MASK_AREA_RATIO_MIN = 0.01;
const MASK_AREA_RATIO_MAX = 0.72;

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function pixelOffset(width: number, x: number, y: number): number {
    return (y * width + x) * 4;
}

function resolveFillRegion(width: number, height: number): FillRegion {
    const scale = clamp(
        Math.min(width / REFERENCE_WIDTH, height / REFERENCE_HEIGHT),
        0.55,
        2.2,
    );

    const wmWidth = clamp(Math.round(WATERMARK_WIDTH * scale), 96, width - 2);
    const wmHeight = clamp(Math.round(WATERMARK_HEIGHT * scale), 28, height - 2);
    const marginRight = clamp(Math.round(MARGIN_RIGHT * scale), 2, Math.floor(width * 0.05));
    const marginBottom = clamp(Math.round(MARGIN_BOTTOM * scale), 2, Math.floor(height * 0.05));

    const x2 = clamp(width - marginRight, 1, width);
    const y2 = clamp(height - marginBottom, 1, height);
    const x1 = clamp(x2 - wmWidth, 0, x2 - 1);
    const y1 = clamp(y2 - wmHeight, 0, y2 - 1);

    const sampleTop = Math.max(2, Math.round(SAMPLE_TOP_START * scale));
    const sampleBottom = Math.max(1, Math.round(SAMPLE_TOP_END * scale));

    const sampleY1 = clamp(y1 - sampleTop, 0, y1);
    const sampleY2 = clamp(y1 - sampleBottom, sampleY1 + 1, y1 + 1);

    return { x1, y1, x2, y2, sampleY1, sampleY2 };
}

function resolveDetectionRoi(
    width: number,
    height: number,
    region: FillRegion,
): DetectionRoi {
    const regionWidth = region.x2 - region.x1;
    const regionHeight = region.y2 - region.y1;

    const padLeft = clamp(Math.round(regionWidth * 0.35), 14, 120);
    const padTop = clamp(Math.round(regionHeight * 0.9), 10, 72);
    const padRight = clamp(Math.round(regionWidth * 0.05), 2, 20);
    const padBottom = clamp(Math.round(regionHeight * 0.08), 1, 8);

    const x1 = clamp(region.x1 - padLeft, 0, width - 1);
    const y1 = clamp(region.y1 - padTop, 0, height - 1);
    const x2 = clamp(region.x2 + padRight, x1 + 1, width);
    const y2 = clamp(region.y2 + padBottom, y1 + 1, height);

    return { x1, y1, x2, y2 };
}

function buildColumnSamples(imageData: ImageData, region: FillRegion): ColumnSamples {
    const { data, width } = imageData;
    const sampleWidth = region.x2 - region.x1;
    const r = new Uint8ClampedArray(sampleWidth);
    const g = new Uint8ClampedArray(sampleWidth);
    const b = new Uint8ClampedArray(sampleWidth);
    const a = new Uint8ClampedArray(sampleWidth);

    for (let x = region.x1; x < region.x2; x++) {
        let sumR = 0;
        let sumG = 0;
        let sumB = 0;
        let sumA = 0;
        let sampleCount = 0;

        for (let y = region.sampleY1; y < region.sampleY2; y++) {
            const o = pixelOffset(width, x, y);
            const alpha = data[o + 3];

            if (alpha < 8) {
                continue;
            }

            sumR += data[o];
            sumG += data[o + 1];
            sumB += data[o + 2];
            sumA += alpha;
            sampleCount++;
        }

        const col = x - region.x1;
        if (sampleCount > 0) {
            r[col] = Math.round(sumR / sampleCount);
            g[col] = Math.round(sumG / sampleCount);
            b[col] = Math.round(sumB / sampleCount);
            a[col] = Math.round(sumA / sampleCount);
            continue;
        }

        const fallbackY = Math.max(0, region.y1 - 1);
        const fallbackOffset = pixelOffset(width, x, fallbackY);
        r[col] = data[fallbackOffset];
        g[col] = data[fallbackOffset + 1];
        b[col] = data[fallbackOffset + 2];
        a[col] = data[fallbackOffset + 3];
    }

    return { r, g, b, a };
}

function buildGrayRoi(imageData: ImageData, roi: DetectionRoi): Uint8Array {
    const { data, width } = imageData;
    const roiWidth = roi.x2 - roi.x1;
    const roiHeight = roi.y2 - roi.y1;
    const gray = new Uint8Array(roiWidth * roiHeight);

    for (let y = roi.y1; y < roi.y2; y++) {
        for (let x = roi.x1; x < roi.x2; x++) {
            const srcOffset = pixelOffset(width, x, y);
            const idx = (y - roi.y1) * roiWidth + (x - roi.x1);
            const rr = data[srcOffset];
            const gg = data[srcOffset + 1];
            const bb = data[srcOffset + 2];
            gray[idx] = (rr * 77 + gg * 150 + bb * 29) >> 8;
        }
    }

    return gray;
}

function buildDiffMask(gray: Uint8Array, roiWidth: number, roiHeight: number): Uint8Array {
    const size = roiWidth * roiHeight;
    const diff = new Uint8Array(size);
    const neighborhood = new Array<number>(9);
    let sumDiff = 0;

    for (let y = 0; y < roiHeight; y++) {
        const y0 = Math.max(0, y - 1);
        const y1 = y;
        const y2 = Math.min(roiHeight - 1, y + 1);

        for (let x = 0; x < roiWidth; x++) {
            const x0 = Math.max(0, x - 1);
            const x1 = x;
            const x2 = Math.min(roiWidth - 1, x + 1);

            neighborhood[0] = gray[y0 * roiWidth + x0];
            neighborhood[1] = gray[y0 * roiWidth + x1];
            neighborhood[2] = gray[y0 * roiWidth + x2];
            neighborhood[3] = gray[y1 * roiWidth + x0];
            neighborhood[4] = gray[y1 * roiWidth + x1];
            neighborhood[5] = gray[y1 * roiWidth + x2];
            neighborhood[6] = gray[y2 * roiWidth + x0];
            neighborhood[7] = gray[y2 * roiWidth + x1];
            neighborhood[8] = gray[y2 * roiWidth + x2];
            neighborhood.sort((a, b) => a - b);

            const idx = y * roiWidth + x;
            const d = Math.abs(gray[idx] - neighborhood[4]);
            diff[idx] = d;
            sumDiff += d;
        }
    }

    const meanDiff = sumDiff / size;
    let variance = 0;
    for (let i = 0; i < size; i++) {
        const delta = diff[i] - meanDiff;
        variance += delta * delta;
    }

    const stdDev = Math.sqrt(variance / size);
    const threshold = clamp(
        Math.round(meanDiff + stdDev * 0.85),
        DIFF_MIN_THRESHOLD,
        DIFF_MAX_THRESHOLD,
    );

    const binary = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
        binary[i] = diff[i] >= threshold ? 1 : 0;
    }

    return binary;
}

function collectComponents(mask: Uint8Array, width: number, height: number): ComponentStats[] {
    const visited = new Uint8Array(mask.length);
    const stack: number[] = [];
    const components: ComponentStats[] = [];

    for (let start = 0; start < mask.length; start++) {
        if (mask[start] === 0 || visited[start] === 1) {
            continue;
        }

        let x1 = width;
        let y1 = height;
        let x2 = 0;
        let y2 = 0;
        const pixels: number[] = [];

        stack.push(start);
        visited[start] = 1;

        while (stack.length > 0) {
            const idx = stack.pop()!;
            pixels.push(idx);

            const y = Math.floor(idx / width);
            const x = idx - y * width;

            if (x < x1) {
                x1 = x;
            }
            if (y < y1) {
                y1 = y;
            }
            if (x > x2) {
                x2 = x;
            }
            if (y > y2) {
                y2 = y;
            }

            for (let ny = Math.max(0, y - 1); ny <= Math.min(height - 1, y + 1); ny++) {
                for (let nx = Math.max(0, x - 1); nx <= Math.min(width - 1, x + 1); nx++) {
                    if (nx === x && ny === y) {
                        continue;
                    }

                    const neighbor = ny * width + nx;
                    if (mask[neighbor] === 0 || visited[neighbor] === 1) {
                        continue;
                    }

                    visited[neighbor] = 1;
                    stack.push(neighbor);
                }
            }
        }

        components.push({
            x1,
            y1,
            x2,
            y2,
            area: pixels.length,
            pixels,
        });
    }

    return components;
}

function dilateMask(mask: Uint8Array, width: number, height: number, iterations: number): Uint8Array {
    let src = mask;

    for (let i = 0; i < iterations; i++) {
        const dst = new Uint8Array(src.length);

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = y * width + x;
                if (src[idx] === 1) {
                    dst[idx] = 1;
                    continue;
                }

                let hasNeighbor = false;
                for (let ny = Math.max(0, y - 1); ny <= Math.min(height - 1, y + 1) && !hasNeighbor; ny++) {
                    for (let nx = Math.max(0, x - 1); nx <= Math.min(width - 1, x + 1); nx++) {
                        if (src[ny * width + nx] === 1) {
                            hasNeighbor = true;
                            break;
                        }
                    }
                }

                if (hasNeighbor) {
                    dst[idx] = 1;
                }
            }
        }

        src = dst;
    }

    return src;
}

function buildWatermarkMask(
    imageData: ImageData,
    roi: DetectionRoi,
    fillRegion: FillRegion,
): Uint8Array | null {
    const roiWidth = roi.x2 - roi.x1;
    const roiHeight = roi.y2 - roi.y1;
    const gray = buildGrayRoi(imageData, roi);
    const diffMask = buildDiffMask(gray, roiWidth, roiHeight);
    const components = collectComponents(diffMask, roiWidth, roiHeight);

    const minComponentArea = Math.max(20, Math.round(roiWidth * roiHeight * 0.002));
    const minTotalArea = Math.max(64, Math.round(roiWidth * roiHeight * 0.006));

    const selected = new Uint8Array(diffMask.length);
    let selectedArea = 0;

    for (const comp of components) {
        if (comp.area < minComponentArea) {
            continue;
        }

        const compWidth = comp.x2 - comp.x1 + 1;
        const compHeight = comp.y2 - comp.y1 + 1;
        const centerX = comp.x1 + compWidth / 2;
        const centerY = comp.y1 + compHeight / 2;

        if (centerX < roiWidth * 0.46 || centerY < roiHeight * 0.36) {
            continue;
        }

        if (compWidth > roiWidth * 0.9 || compHeight > roiHeight * 0.9) {
            continue;
        }

        for (const pixel of comp.pixels) {
            if (selected[pixel] === 1) {
                continue;
            }

            selected[pixel] = 1;
            selectedArea++;
        }
    }

    if (selectedArea < minTotalArea) {
        return null;
    }

    const dilated = dilateMask(selected, roiWidth, roiHeight, 2);

    let overlapWithFillRegion = 0;
    for (let y = fillRegion.y1; y < fillRegion.y2; y++) {
        if (y < roi.y1 || y >= roi.y2) {
            continue;
        }

        for (let x = fillRegion.x1; x < fillRegion.x2; x++) {
            if (x < roi.x1 || x >= roi.x2) {
                continue;
            }

            const idx = (y - roi.y1) * roiWidth + (x - roi.x1);
            if (dilated[idx] === 1) {
                overlapWithFillRegion++;
            }
        }
    }

    if (overlapWithFillRegion === 0) {
        return null;
    }

    return dilated;
}

function countMaskNeighbors(
    mask: Uint8Array,
    width: number,
    height: number,
    x: number,
    y: number,
): number {
    let count = 0;
    for (let ny = Math.max(0, y - 1); ny <= Math.min(height - 1, y + 1); ny++) {
        for (let nx = Math.max(0, x - 1); nx <= Math.min(width - 1, x + 1); nx++) {
            if (nx === x && ny === y) {
                continue;
            }

            if (mask[ny * width + nx] === 1) {
                count++;
            }
        }
    }

    return count;
}

function countMaskPixelsInFillRegion(
    mask: Uint8Array,
    roi: DetectionRoi,
    region: FillRegion,
): number {
    const roiWidth = roi.x2 - roi.x1;
    let count = 0;

    for (let y = region.y1; y < region.y2; y++) {
        if (y < roi.y1 || y >= roi.y2) {
            continue;
        }

        for (let x = region.x1; x < region.x2; x++) {
            if (x < roi.x1 || x >= roi.x2) {
                continue;
            }

            const idx = (y - roi.y1) * roiWidth + (x - roi.x1);
            if (mask[idx] === 1) {
                count++;
            }
        }
    }

    return count;
}

function applyMaskedFill(
    imageData: ImageData,
    region: FillRegion,
    roi: DetectionRoi,
    mask: Uint8Array,
    samples: ColumnSamples,
): void {
    const { data, width } = imageData;
    const roiWidth = roi.x2 - roi.x1;
    const roiHeight = roi.y2 - roi.y1;

    for (let y = region.y1; y < region.y2; y++) {
        if (y < roi.y1 || y >= roi.y2) {
            continue;
        }

        for (let x = region.x1; x < region.x2; x++) {
            if (x < roi.x1 || x >= roi.x2) {
                continue;
            }

            const rx = x - roi.x1;
            const ry = y - roi.y1;
            const maskIdx = ry * roiWidth + rx;
            if (mask[maskIdx] === 0) {
                continue;
            }

            const neighbors = countMaskNeighbors(mask, roiWidth, roiHeight, rx, ry);
            const blend = neighbors >= 5 ? 1 : 0.82;
            const col = x - region.x1;
            const o = pixelOffset(width, x, y);

            data[o] = Math.round(data[o] * (1 - blend) + samples.r[col] * blend);
            data[o + 1] = Math.round(data[o + 1] * (1 - blend) + samples.g[col] * blend);
            data[o + 2] = Math.round(data[o + 2] * (1 - blend) + samples.b[col] * blend);
            data[o + 3] = Math.round(data[o + 3] * (1 - blend) + samples.a[col] * blend);
        }
    }
}

function applyFullRegionFill(
    imageData: ImageData,
    region: FillRegion,
    samples: ColumnSamples,
): void {
    const { data, width } = imageData;

    for (let x = region.x1; x < region.x2; x++) {
        const col = x - region.x1;
        const fillR = samples.r[col];
        const fillG = samples.g[col];
        const fillB = samples.b[col];
        const fillA = samples.a[col];

        for (let y = region.y1; y < region.y2; y++) {
            const o = pixelOffset(width, x, y);
            const row = y - region.y1;

            // Soften the seam at the region's top edge.
            if (row < 2) {
                const t = (row + 1) / 3;
                data[o] = Math.round(data[o] * (1 - t) + fillR * t);
                data[o + 1] = Math.round(data[o + 1] * (1 - t) + fillG * t);
                data[o + 2] = Math.round(data[o + 2] * (1 - t) + fillB * t);
                data[o + 3] = Math.round(data[o + 3] * (1 - t) + fillA * t);
                continue;
            }

            data[o] = fillR;
            data[o + 1] = fillG;
            data[o + 2] = fillB;
            data[o + 3] = fillA;
        }
    }
}

/**
 * NotebookLM watermark removal for exported infographic images.
 *
 * Strategy:
 * 1) Detect likely watermark pixels in bottom-right ROI with local-difference mask.
 * 2) Replace masked pixels using per-column background sampling.
 * 3) Fallback to full region column fill when mask quality is not trustworthy.
 */
export async function removeNotebookLmWatermarkFromBlob(blob: Blob): Promise<Blob> {
    const bitmap = await createImageBitmap(blob);
    const { width, height } = bitmap;

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        bitmap.close();
        throw new Error('Failed to get 2D context');
    }

    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();

    const imageData = ctx.getImageData(0, 0, width, height);
    const fillRegion = resolveFillRegion(width, height);
    const samples = buildColumnSamples(imageData, fillRegion);
    const detectionRoi = resolveDetectionRoi(width, height, fillRegion);
    const mask = buildWatermarkMask(imageData, detectionRoi, fillRegion);

    if (mask) {
        const regionArea = (fillRegion.x2 - fillRegion.x1) * (fillRegion.y2 - fillRegion.y1);
        const maskedArea = countMaskPixelsInFillRegion(mask, detectionRoi, fillRegion);
        const ratio = maskedArea / Math.max(1, regionArea);

        if (ratio >= MASK_AREA_RATIO_MIN && ratio <= MASK_AREA_RATIO_MAX) {
            applyMaskedFill(imageData, fillRegion, detectionRoi, mask, samples);
        } else {
            applyFullRegionFill(imageData, fillRegion, samples);
        }
    } else {
        applyFullRegionFill(imageData, fillRegion, samples);
    }

    ctx.putImageData(imageData, 0, 0);
    return canvas.convertToBlob({ type: 'image/png' });
}
