import { logWarn } from '@/lib/observability/client-log';
import { Match } from '@/types/match';
import { MatchExtras } from '@/hooks/useMatchExtras';
import { buildShareCardModel, type ShareCardPalette } from './share-match-card-theme';

interface ShareImageOptions {
  match: Match;
  localTeamLogo?: string;
  awayTeamLogo?: string;
  extras?: MatchExtras | null;
  clubName?: string;
  clubAbbreviation?: string;
  clubLogo?: string;
  primaryColor?: string;
  secondaryColor?: string;
}

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

function proxiedSrc(src: string): string {
  const sameOrigin = typeof window !== 'undefined' ? window.location.origin : '';
  return /^https?:\/\//i.test(src) && !src.startsWith(sameOrigin)
    ? `/api/logo-proxy?url=${encodeURIComponent(src)}`
    : src;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${src}`));
    img.src = proxiedSrc(src);
  });
}

async function tryLoadImage(src?: string): Promise<HTMLImageElement | null> {
  if (!src) return null;
  try {
    return await loadImage(src);
  } catch (error) {
    logWarn('app.unhandled', 'Failed to load share-card image:', error);
    return null;
  }
}

function hexToRgb(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function setFont(ctx: CanvasRenderingContext2D, size: number, weight: number | string = 600) {
  ctx.font = `${weight} ${size}px ${FONT}`;
}

function drawText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  size: number,
  color: string,
  align: CanvasTextAlign = 'left',
  weight: number | string = 600,
) {
  ctx.save();
  setFont(ctx, size, weight);
  ctx.textAlign = align;
  ctx.textBaseline = 'top';
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

function truncateText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  size: number,
  weight: number | string = 700,
): string {
  setFont(ctx, size, weight);
  if (ctx.measureText(text).width <= maxWidth) return text;
  let truncated = text;
  while (truncated.length > 0 && ctx.measureText(`${truncated}…`).width > maxWidth) {
    truncated = truncated.slice(0, -1);
  }
  return `${truncated}…`;
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  size: number,
  weight: number | string = 700,
  maxLines = 2,
): string[] {
  setFont(ctx, size, weight);
  const lines: string[] = [];

  const flush = (value: string) => {
    lines.push(truncateText(ctx, value, maxWidth, size, weight));
  };

  for (const paragraph of text.split('\n')) {
    if (lines.length >= maxLines) break;
    const words = paragraph.split(/\s+/).filter(Boolean);
    let current = '';
    for (const word of words) {
      const next = current ? `${current} ${word}` : word;
      if (ctx.measureText(next).width <= maxWidth) {
        current = next;
        continue;
      }
      if (current) flush(current);
      current = word;
      if (lines.length >= maxLines) {
        current = '';
        break;
      }
    }
    if (current && lines.length < maxLines) flush(current);
  }

  return lines.length ? lines.slice(0, maxLines) : [truncateText(ctx, text, maxWidth, size, weight)];
}

function drawChip(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  fill: string,
  color: string,
  scale: number,
): number {
  const padX = 16 * scale;
  const height = 34 * scale;
  setFont(ctx, 14 * scale, 700);
  const width = ctx.measureText(text).width + padX * 2;
  ctx.fillStyle = fill;
  roundRect(ctx, x, y, width, height, 999);
  ctx.fill();
  drawText(ctx, text, x + padX, y + 8 * scale, 14 * scale, color, 'left', 700);
  return width;
}

function drawLogoBox(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement | null,
  fallback: string,
  x: number,
  y: number,
  size: number,
  palette: ShareCardPalette,
  scale: number,
) {
  ctx.fillStyle = withAlpha(palette.onSecondary === '#111827' ? '#ffffff' : palette.primary, 0.92);
  roundRect(ctx, x, y, size, size, 18 * scale);
  ctx.fill();
  ctx.strokeStyle = withAlpha(palette.primary, 0.16);
  ctx.lineWidth = 2 * scale;
  ctx.stroke();

  const pad = 12 * scale;
  if (img) {
    ctx.save();
    roundRect(ctx, x + pad, y + pad, size - pad * 2, size - pad * 2, 10 * scale);
    ctx.clip();
    ctx.drawImage(img, x + pad, y + pad, size - pad * 2, size - pad * 2);
    ctx.restore();
    return;
  }

  drawText(
    ctx,
    fallback,
    x + size / 2,
    y + size / 2 - 18 * scale,
    36 * scale,
    palette.primary,
    'center',
    800,
  );
}

/**
 * Génère une carte match 1200×630 aux couleurs primaire / secondaire du club.
 */
export async function generateMatchShareImageCanvas({
  match,
  localTeamLogo,
  awayTeamLogo,
  extras,
  clubName,
  clubAbbreviation,
  clubLogo,
  primaryColor,
  secondaryColor,
}: ShareImageOptions): Promise<Blob> {
  const card = buildShareCardModel({
    match,
    extras,
    clubName,
    clubAbbreviation,
    primaryColor,
    secondaryColor,
  });
  const { palette } = card;

  const width = 1200;
  const height = 630;
  const scale = 2;
  const w = width * scale;
  const h = height * scale;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Impossible de créer le contexte canvas');

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const [localLogoImg, awayLogoImg, clubLogoImg] = await Promise.all([
    tryLoadImage(localTeamLogo),
    tryLoadImage(awayTeamLogo),
    tryLoadImage(clubLogo),
  ]);

  const headerH = 148 * scale;
  const footerH = card.facts.length ? 148 * scale : 76 * scale;
  const bodyH = h - headerH - footerH;
  const pad = 36 * scale;
  const chipFill = palette.onPrimary === '#f8fafc' ? '#ffffff' : palette.chipOnPrimary;
  const chipColor = palette.onPrimary === '#f8fafc' ? palette.primary : palette.onPrimary;

  ctx.fillStyle = palette.secondary;
  ctx.fillRect(0, 0, w, h);

  const headerGradient = ctx.createLinearGradient(0, 0, w, headerH);
  headerGradient.addColorStop(0, palette.primary);
  headerGradient.addColorStop(1, withAlpha(palette.primary, 0.86));
  ctx.fillStyle = headerGradient;
  ctx.fillRect(0, 0, w, headerH);

  const accent = ctx.createLinearGradient(0, headerH - 6 * scale, w, headerH);
  accent.addColorStop(0, withAlpha(palette.secondary, 0.15));
  accent.addColorStop(1, withAlpha('#ffffff', 0.28));
  ctx.fillStyle = accent;
  ctx.fillRect(0, headerH - 4 * scale, w, 4 * scale);

  const logoSize = 58 * scale;
  let headerTextX = pad;
  if (clubLogoImg) {
    ctx.fillStyle = withAlpha('#ffffff', 0.16);
    roundRect(ctx, pad, pad, logoSize, logoSize, 16 * scale);
    ctx.fill();
    ctx.save();
    roundRect(ctx, pad + 6 * scale, pad + 6 * scale, logoSize - 12 * scale, logoSize - 12 * scale, 10 * scale);
    ctx.clip();
    ctx.drawImage(clubLogoImg, pad + 6 * scale, pad + 6 * scale, logoSize - 12 * scale, logoSize - 12 * scale);
    ctx.restore();
    headerTextX = pad + logoSize + 16 * scale;
  }

  if (card.clubName) {
    drawText(ctx, truncateText(ctx, card.clubName, 480 * scale, 28 * scale, 800), headerTextX, pad + 2 * scale, 28 * scale, palette.onPrimary, 'left', 800);
  }

  const meta = [card.competition, card.date].filter(Boolean).join('  ·  ');
  drawText(
    ctx,
    truncateText(ctx, meta, 560 * scale, 18 * scale, 600),
    headerTextX,
    pad + 40 * scale,
    18 * scale,
    withAlpha(palette.onPrimary, 0.86),
    'left',
    600,
  );

  let chipX = w - pad;
  const chips = [card.typeLabel, card.venue].filter((value): value is string => Boolean(value));
  for (const chip of chips.reverse()) {
    setFont(ctx, 14 * scale, 700);
    const chipW = ctx.measureText(chip).width + 32 * scale;
    chipX -= chipW;
    drawChip(ctx, chip, chipX, pad + 8 * scale, chipFill, chipColor, scale);
    chipX -= 10 * scale;
  }

  const bodyY = headerH;
  const teamColW = 400 * scale;
  const logoBox = 148 * scale;
  const leftX = pad;
  const rightX = w - pad - teamColW;
  const centerX = w / 2;
  const logoY = bodyY + (bodyH - logoBox - 72 * scale) / 2;

  drawLogoBox(ctx, localLogoImg, card.homeTeam.charAt(0).toUpperCase(), leftX + (teamColW - logoBox) / 2, logoY, logoBox, palette, scale);
  drawLogoBox(ctx, awayLogoImg, card.awayTeam.charAt(0).toUpperCase(), rightX + (teamColW - logoBox) / 2, logoY, logoBox, palette, scale);

  const nameY = logoY + logoBox + 16 * scale;
  const homeLines = wrapText(ctx, card.homeTeam, teamColW, 26 * scale, 800);
  homeLines.forEach((line, index) => {
    drawText(ctx, line, leftX + teamColW / 2, nameY + index * 32 * scale, 26 * scale, palette.onSecondary, 'center', 800);
  });
  const awayLines = wrapText(ctx, card.awayTeam, teamColW, 26 * scale, 800);
  awayLines.forEach((line, index) => {
    drawText(ctx, line, rightX + teamColW / 2, nameY + index * 32 * scale, 26 * scale, palette.onSecondary, 'center', 800);
  });

  const vsY = bodyY + bodyH / 2 - 62 * scale;
  drawText(ctx, 'VS', centerX, vsY, 32 * scale, palette.primary, 'center', 800);

  const timeW = 168 * scale;
  const timeH = 64 * scale;
  const timeX = centerX - timeW / 2;
  const timeY = vsY + 44 * scale;
  ctx.fillStyle = palette.primary;
  roundRect(ctx, timeX, timeY, timeW, timeH, 18 * scale);
  ctx.fill();
  drawText(ctx, card.time || '—', centerX, timeY + 16 * scale, 30 * scale, palette.onPrimary, 'center', 800);

  if (card.rendezVous) {
    drawText(
      ctx,
      `RDV ${card.rendezVous}`,
      centerX,
      timeY + timeH + 14 * scale,
      16 * scale,
      palette.mutedOnSecondary,
      'center',
      700,
    );
  }

  const footerY = h - footerH;
  ctx.fillStyle = withAlpha(palette.primary, palette.onSecondary === '#111827' ? 0.08 : 0.22);
  ctx.fillRect(0, footerY, w, footerH);
  ctx.fillStyle = withAlpha(palette.primary, 0.18);
  ctx.fillRect(0, footerY, w, 2 * scale);

  if (card.facts.length) {
    const columns = Math.min(card.facts.length, 3);
    const colW = (w - pad * 2) / columns;
    card.facts.slice(0, 3).forEach((fact, index) => {
      const x = pad + index * colW;
      drawText(ctx, fact.label.toUpperCase(), x, footerY + 24 * scale, 14 * scale, palette.primary, 'left', 800);
      const lines = wrapText(ctx, fact.value, colW - 20 * scale, 18 * scale, 600, 2);
      lines.forEach((line, lineIndex) => {
        drawText(ctx, line, x, footerY + 48 * scale + lineIndex * 24 * scale, 18 * scale, palette.onSecondary, 'left', 600);
      });
    });
  } else if (card.clubName) {
    drawText(ctx, card.clubName, pad, footerY + 28 * scale, 20 * scale, palette.onSecondary, 'left', 700);
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Échec de la conversion du canvas en image'));
    }, 'image/png', 1.0);
  });
}
