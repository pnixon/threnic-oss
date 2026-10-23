/**
 * WatermarkCompositor — Renders the Threnic branded watermark onto export frames.
 *
 * Composites the Threnic logo icon + "THRENIC" text into the bottom-right
 * corner of each exported video frame. The watermark is pre-rendered once at
 * the target resolution and then stamped per frame via drawImage.
 *
 * Visual spec:
 *   - Logo: Threnic_Logo.png scaled to ~3.5% of frame height
 *   - Text: "THRENIC" in Inter 900 italic uppercase, crimson #ef4444
 *   - Position: Bottom-right, 3% margin
 *   - Opacity: ~40%
 *   - Drop shadow for readability on any background
 *
 * Used by DecoupledExporter when `watermark: true` is set in the export config.
 */

const WATERMARK_TEXT = 'THRENIC';
const WATERMARK_FONT_FAMILY = 'Inter, sans-serif';
const WATERMARK_FONT_WEIGHT = '900';
const WATERMARK_COLOR = '#ef4444';
const WATERMARK_OPACITY = 0.4;
const WATERMARK_MARGIN_PERCENT = 0.03; // 3% margin from edges
const WATERMARK_LOGO_HEIGHT_PERCENT = 0.035; // 3.5% of frame height
const WATERMARK_FONT_SIZE_PERCENT = 0.018; // 1.8% of frame height
const WATERMARK_LOGO_PATH = '/Threnic_Logo.png';

export class WatermarkCompositor {
  private _stampCanvas: OffscreenCanvas | null = null;
  private _stampWidth = 0;
  private _stampHeight = 0;
  private _logoBitmap: ImageBitmap | null = null;

  /**
   * Initialize the compositor by loading the logo and font.
   * Call once before the frame loop begins.
   */
  async init(): Promise<boolean> {
    try {
      // 1. Load the Threnic logo
      const logoResponse = await fetch(WATERMARK_LOGO_PATH);
      if (!logoResponse.ok) {
        console.warn(`[WatermarkCompositor] Failed to fetch logo: ${logoResponse.status}`);
      } else {
        const logoBlob = await logoResponse.blob();
        this._logoBitmap = await createImageBitmap(logoBlob);
      }

      // 2. Load Inter font (if not already available)
      try {
        const font = new FontFace(
          'Inter',
          'url(https://fonts.gstatic.com/s/inter/v18/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuBWYAZ9hiJ-Ek-_EeA.woff2)',
          { weight: '900', style: 'italic' },
        );
        const loadedFont = await font.load();
        (self as unknown as { fonts?: Partial<Pick<FontFaceSet, 'add'>> }).fonts?.add?.(loadedFont);
      } catch {
        console.warn('[WatermarkCompositor] Inter font load failed, using fallback');
      }

      return true;
    } catch (err) {
      console.error('[WatermarkCompositor] Init failed:', err);
      return false;
    }
  }

  /**
   * Composite the watermark onto the given canvas context.
   * Fully synchronous — pre-renders the stamp canvas once per resolution,
   * then drawImage per frame.
   */
  compositeSync(
    ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
    width: number,
    height: number,
  ): void {
    // Regenerate stamp if dimensions changed
    if (!this._stampCanvas || this._stampWidth !== width || this._stampHeight !== height) {
      this._buildStamp(width, height);
    }

    if (!this._stampCanvas) return;

    const margin = Math.round(width * WATERMARK_MARGIN_PERCENT);
    const x = width - this._stampCanvas.width - margin;
    const y = height - this._stampCanvas.height - margin;

    ctx.globalAlpha = WATERMARK_OPACITY;
    ctx.drawImage(this._stampCanvas, x, y);
    ctx.globalAlpha = 1.0;
  }

  /**
   * Pre-render the watermark (logo + text) onto a reusable OffscreenCanvas.
   * Called once per resolution change.
   */
  private _buildStamp(frameWidth: number, frameHeight: number): void {
    this._stampWidth = frameWidth;
    this._stampHeight = frameHeight;

    const logoHeight = Math.round(frameHeight * WATERMARK_LOGO_HEIGHT_PERCENT);
    const fontSize = Math.max(10, Math.round(frameHeight * WATERMARK_FONT_SIZE_PERCENT));
    const padding = Math.round(fontSize * 0.4);

    // Logo dimensions (preserving aspect ratio)
    const logoWidth = this._logoBitmap
      ? Math.round(logoHeight * (this._logoBitmap.width / this._logoBitmap.height))
      : 0;

    // Measure text width
    const measureCanvas = new OffscreenCanvas(1, 1);
    const measureCtx = measureCanvas.getContext('2d')!;
    measureCtx.font = `italic ${WATERMARK_FONT_WEIGHT} ${fontSize}px ${WATERMARK_FONT_FAMILY}`;
    const textWidth = Math.ceil(measureCtx.measureText(WATERMARK_TEXT).width);

    const totalWidth = Math.max(logoWidth, textWidth) + padding * 2;
    const totalHeight = (this._logoBitmap ? logoHeight + padding : 0) + fontSize + padding * 2;

    // Create the stamp canvas
    this._stampCanvas = new OffscreenCanvas(totalWidth, totalHeight);
    const ctx = this._stampCanvas.getContext('2d')!;
    ctx.clearRect(0, 0, totalWidth, totalHeight);

    let yOffset = padding;

    // Draw logo (centered horizontally)
    if (this._logoBitmap) {
      const logoX = Math.round((totalWidth - logoWidth) / 2);
      ctx.drawImage(this._logoBitmap, logoX, yOffset, logoWidth, logoHeight);
      yOffset += logoHeight + padding;
    }

    // Draw "THRENIC" text (centered horizontally)
    ctx.font = `italic ${WATERMARK_FONT_WEIGHT} ${fontSize}px ${WATERMARK_FONT_FAMILY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    // Drop shadow for readability on light backgrounds
    ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
    ctx.shadowBlur = Math.max(2, fontSize * 0.15);
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 1;

    ctx.fillStyle = WATERMARK_COLOR;
    ctx.fillText(WATERMARK_TEXT, totalWidth / 2, yOffset);

    // Reset shadow
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
  }

  /**
   * Release resources.
   */
  dispose(): void {
    this._stampCanvas = null;
    this._logoBitmap?.close();
    this._logoBitmap = null;
  }
}
