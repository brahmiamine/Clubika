import { logError, logWarn } from '@/lib/observability/client-log';
import jsPDF from 'jspdf';
import { Match, Entrainement, Plateau, ClubInfo } from '@/types/match';
import { MatchExtras } from '@/hooks/useMatchExtras';
import { formatDateWithDayName } from './date';
import { DEFAULT_APP_SETTINGS, roleLabelWithClub } from '@/lib/settings';

type Event = Match | Entrainement | Plateau;

export type PdfRgb = [number, number, number];

export interface PdfClubBranding {
  primaryColor?: string;
  secondaryColor?: string;
}

export interface PdfPalette {
  primary: PdfRgb;
  secondary: PdfRgb;
  headerText: PdfRgb;
  altRow: PdfRgb;
  headerBand: PdfRgb;
  bodyText: PdfRgb;
  paper: PdfRgb;
}

const FALLBACK_PRIMARY: PdfRgb = [31, 41, 55]; // #1f2937
const FALLBACK_SECONDARY: PdfRgb = [229, 231, 235]; // #e5e7eb
const PAPER: PdfRgb = [255, 255, 255];
const BODY_TEXT: PdfRgb = [17, 24, 39];

/** Convertit un HEX club (`#rgb` / `#rrggbb`) en RGB jsPDF, avec fallback sûr. */
export function hexToRgb(hex: string | undefined | null, fallback: PdfRgb): PdfRgb {
  if (typeof hex !== 'string') return fallback;
  const trimmed = hex.trim();
  const match = trimmed.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  if (!match?.[1]) return fallback;
  let digits = match[1];
  if (digits.length === 3) {
    const r = digits[0] ?? '0';
    const g = digits[1] ?? '0';
    const b = digits[2] ?? '0';
    digits = `${r}${r}${g}${g}${b}${b}`;
  }
  const r = Number.parseInt(digits.slice(0, 2), 16);
  const g = Number.parseInt(digits.slice(2, 4), 16);
  const b = Number.parseInt(digits.slice(4, 6), 16);
  if ([r, g, b].some((channel) => Number.isNaN(channel))) return fallback;
  return [r, g, b];
}

function channelLuminance(channel: number): number {
  const value = channel / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(rgb: PdfRgb): number {
  return 0.2126 * channelLuminance(rgb[0]) + 0.7152 * channelLuminance(rgb[1]) + 0.0722 * channelLuminance(rgb[2]);
}

function contrastingText(background: PdfRgb): PdfRgb {
  return relativeLuminance(background) > 0.5 ? BODY_TEXT : [249, 250, 251];
}

function mixWithPaper(rgb: PdfRgb, paperAmount: number): PdfRgb {
  return [
    Math.round(rgb[0] + (255 - rgb[0]) * paperAmount),
    Math.round(rgb[1] + (255 - rgb[1]) * paperAmount),
    Math.round(rgb[2] + (255 - rgb[2]) * paperAmount),
  ];
}

export function resolvePdfPalette(branding?: PdfClubBranding): PdfPalette {
  const primary = hexToRgb(branding?.primaryColor, hexToRgb(DEFAULT_APP_SETTINGS.primaryColor, FALLBACK_PRIMARY));
  const secondary = hexToRgb(branding?.secondaryColor, hexToRgb(DEFAULT_APP_SETTINGS.accentColor, FALLBACK_SECONDARY));
  return {
    primary,
    secondary,
    headerText: contrastingText(primary),
    altRow: mixWithPaper(secondary, 0.78),
    headerBand: mixWithPaper(secondary, 0.88),
    bodyText: BODY_TEXT,
    paper: PAPER,
  };
}

interface FieldConfig {
  label: string;
  key: string;
  enabled: boolean;
}

export function detectPdfImageFormat(dataUrl: string): 'PNG' | 'JPEG' | 'WEBP' | null {
  if (dataUrl.startsWith('data:image/png')) return 'PNG';
  if (dataUrl.startsWith('data:image/jpeg') || dataUrl.startsWith('data:image/jpg')) return 'JPEG';
  if (dataUrl.startsWith('data:image/webp')) return 'WEBP';
  return null;
}

export function fitContain(srcW: number, srcH: number, boxW: number, boxH: number): {
  w: number;
  h: number;
  x: number;
  y: number;
} {
  if (srcW <= 0 || srcH <= 0) return { w: boxW, h: boxH, x: 0, y: 0 };
  const scale = Math.min(boxW / srcW, boxH / srcH);
  const w = srcW * scale;
  const h = srcH * scale;
  return { w, h, x: (boxW - w) / 2, y: (boxH - h) / 2 };
}

export function proxiedPdfLogoSrc(src: string): string {
  const trimmed = src.trim();
  if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('/')) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    if (!origin || !trimmed.startsWith(origin)) {
      return `/api/logo-proxy?url=${encodeURIComponent(trimmed)}`;
    }
  }
  return trimmed;
}

async function loadImageAsBase64(url: string): Promise<string | null> {
  try {
    if (url.startsWith('data:')) {
      return url;
    }

    const response = await fetch(url, {
      mode: 'cors',
      credentials: 'same-origin',
    });

    if (!response.ok) {
      logWarn('app.unhandled');
      return null;
    }

    const blob = await response.blob();
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    logWarn('app.unhandled');
    return null;
  }
}

async function rasterizeLogoToPng(src: string): Promise<string | null> {
  if (typeof Image === 'undefined' || typeof document === 'undefined') return null;

  const image = await new Promise<HTMLImageElement | null>((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
  if (!image?.naturalWidth || !image.naturalHeight) return null;

  const size = 256;
  const fit = fitContain(image.naturalWidth, image.naturalHeight, size, size);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.clearRect(0, 0, size, size);
  ctx.drawImage(image, fit.x, fit.y, fit.w, fit.h);
  try {
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

export async function prepareClubLogoForPdf(url: string): Promise<string | null> {
  const src = proxiedPdfLogoSrc(url);
  if (!src) return null;

  const rasterized = await rasterizeLogoToPng(src);
  if (rasterized) return rasterized;

  if (src.startsWith('data:')) {
    return detectPdfImageFormat(src) ? src : null;
  }

  const fetched = await loadImageAsBase64(src);
  return fetched && detectPdfImageFormat(fetched) ? fetched : null;
}

export async function generatePdf(
  events: Event[],
  _fields: FieldConfig[], // Non utilisé mais gardé pour compatibilité
  allExtras: Record<string, MatchExtras>,
  club?: ClubInfo,
  clubAbbreviation?: string,
  branding?: PdfClubBranding,
) {
  // Créer un PDF en format paysage A4
  const doc = new jsPDF({
    orientation: 'landscape',
    unit: 'mm',
    format: 'a4',
  });

  const pageWidth = doc.internal.pageSize.getWidth(); // 297mm en paysage
  const pageHeight = doc.internal.pageSize.getHeight(); // 210mm en paysage
  const margin = 8;
  const contentWidth = pageWidth - 2 * margin;
  const palette = resolvePdfPalette(branding);

  let yPosition = margin;


  // En-tête avec logo, nom du club et bandeau aux couleurs du club
  const headerHeight = 20;
  doc.setFillColor(palette.headerBand[0], palette.headerBand[1], palette.headerBand[2]);
  doc.rect(margin, yPosition, contentWidth, headerHeight, 'F');
  doc.setDrawColor(palette.primary[0], palette.primary[1], palette.primary[2]);
  doc.setLineWidth(0.5);
  doc.line(margin, yPosition + headerHeight, margin + contentWidth, yPosition + headerHeight);

  let logoReady: string | null = null;
  if (club?.logo) {
    try {
      logoReady = await prepareClubLogoForPdf(club.logo);
    } catch {
      logError('app.unhandled');
    }
  }

  if (logoReady) {
    const box = 16;
    const logoX = margin + 2;
    const logoY = yPosition + 2;
    doc.setFillColor(255, 255, 255);
    if (typeof doc.roundedRect === 'function') {
      doc.roundedRect(logoX, logoY, box, box, 1.5, 1.5, 'F');
    } else {
      doc.rect(logoX, logoY, box, box, 'F');
    }
    const format = detectPdfImageFormat(logoReady) ?? 'PNG';
    doc.addImage(logoReady, format, logoX + 1.2, logoY + 1.2, box - 2.4, box - 2.4);
  }

  // Nom du club (couleur primaire)
  doc.setTextColor(palette.primary[0], palette.primary[1], palette.primary[2]);
  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  const clubNameX = logoReady ? margin + 22 : margin + 3;
  doc.text(club?.name || 'Academie Football Paris 18', clubNameX, yPosition + 9);

  // Description du club
  if (club?.description) {
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.text(club.description, clubNameX, yPosition + 14);
  }

  // Date d'export à droite
  doc.setFontSize(7);
  doc.setFont('helvetica', 'normal');
  const exportDate = new Date().toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const dateTextWidth = doc.getTextWidth(`Exporté le : ${exportDate}`);
  doc.text(`Exporté le : ${exportDate}`, pageWidth - margin - dateTextWidth, yPosition + 9);

  yPosition += headerHeight + 6;

  // Grouper les événements par date
  const eventsByDate: Record<string, Event[]> = {};
  events.forEach((event) => {
    const date = event.date;
    if (!date) return;
    if (!eventsByDate[date]) {
      eventsByDate[date] = [];
    }
    eventsByDate[date].push(event);
  });

  // Trier les dates
  const sortedDates = Object.keys(eventsByDate).sort((a, b) => {
    const partsA = a.split('/').map(Number);
    const partsB = b.split('/').map(Number);
    const [dayA = 1, monthA = 1, yearA = 2000] = partsA;
    const [dayB = 1, monthB = 1, yearB = 2000] = partsB;
    const dateA = new Date(yearA, monthA - 1, dayA);
    const dateB = new Date(yearB, monthB - 1, dayB);
    return dateA.getTime() - dateB.getTime();
  });

  // Afficher toutes les dates (avec pagination si nécessaire)
  const datesToShow = sortedDates;

  // Colonnes du tableau dans l'ordre demandé
  const columns = [
    { key: 'heure', label: 'Heure', width: 12 },
    { key: 'horaireRdv', label: 'RDV', width: 12 },
    { key: 'competition', label: 'Compétition', width: 25 },
    { key: 'equipeLocale', label: 'Équipe locale', width: 30 },
    { key: 'equipeVisiteur', label: 'Équipe visiteur', width: 30 },
    { key: 'adresse', label: 'Adresse', width: 50 },
    { key: 'staff', label: 'Staff', width: 40 },
    { key: 'contacts', label: roleLabelWithClub('Contacts', clubAbbreviation ?? '') || 'Contacts', width: 50 },
  ];

  const totalColumnWidth = columns.reduce((sum, col) => sum + col.width, 0);
  const scaleFactor = contentWidth / totalColumnWidth;

  // Ajuster les largeurs des colonnes
  columns.forEach((col) => {
    col.width = col.width * scaleFactor;
  });

  datesToShow.forEach((date, dateIndex) => {
    // Vérifier si on a besoin d'une nouvelle page avant d'ajouter un nouveau tableau
    if (dateIndex > 0) {
      const spaceNeeded = 20; // Espace pour le titre + en-tête
      if (yPosition + spaceNeeded > pageHeight - margin) {
        doc.addPage();
        yPosition = margin;
      } else {
        yPosition += 8; // Espace entre les tableaux
      }
    }

    const dateEvents = (eventsByDate[date] || []).sort((a, b) => {
      const timeA = 'time' in a ? a.time : '';
      const timeB = 'time' in b ? b.time : '';
      return timeA.localeCompare(timeB);
    });

    // Titre du tableau avec la date et le jour
    doc.setTextColor(palette.primary[0], palette.primary[1], palette.primary[2]);
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    const dateFormatted = formatDateWithDayName(date); // Format "Samedi 17/01/2026"
    doc.text(`Planning du ${dateFormatted}`, margin, yPosition);
    yPosition += 5;

    // En-tête du tableau
    const headerRowHeight = 7;
    doc.setFillColor(palette.primary[0], palette.primary[1], palette.primary[2]);
    doc.rect(margin, yPosition, contentWidth, headerRowHeight, 'F');

    doc.setTextColor(palette.headerText[0], palette.headerText[1], palette.headerText[2]);
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');

    let xPos = margin + 1;
    columns.forEach((col) => {
      const label = col.label.length > 15 ? col.label.substring(0, 13) + '...' : col.label;
      doc.text(label, xPos, yPosition + 5);
      xPos += col.width;
    });

    yPosition += headerRowHeight;

    // Lignes du tableau
    const baseRowHeight = 8; // Hauteur de base pour la lisibilité
    let rowIndex = 0;

    dateEvents.forEach((event) => {
      // Calculer la hauteur de la ligne (peut être plus grande si certaines colonnes sont longues)
      let rowHeight = baseRowHeight;
      let addressLines: string[] = [];

      // Préparer l'adresse pour vérifier si elle nécessite plusieurs lignes
      if ('details' in event && event.details) {
        const stadium = event.details.stadium || '';
        const address = event.details.address || '';
        let fullAddress = '';
        if (stadium && address) {
          fullAddress = `${stadium}, ${address}`;
        } else {
          fullAddress = stadium || address;
        }

        const addressCol = columns.find(col => col.key === 'adresse');
        if (addressCol && fullAddress) {
          const maxWidth = addressCol.width - 2;
          addressLines = doc.splitTextToSize(fullAddress, maxWidth);
          if (addressLines.length > 1) {
            rowHeight = Math.max(rowHeight, baseRowHeight + (addressLines.length - 1) * 3.5);
          }
        }
      }

      // Vérifier aussi la hauteur nécessaire pour Staff et Contacts
      const match = event as Match;
      const extras = match.id ? allExtras[match.id] : null;

      // Calculer la hauteur pour Staff
      const staffCol = columns.find(col => col.key === 'staff');
      if (staffCol) {
        const staffParts: string[] = [];
        if ('staff' in event && event.staff) {
          if (event.staff.referee) staffParts.push(`Arb Off: ${event.staff.referee}`);
          if (event.staff.assistant1) staffParts.push(`Asst1: ${event.staff.assistant1}`);
          if (event.staff.assistant2) staffParts.push(`Asst2: ${event.staff.assistant2}`);
        }
        if (staffParts.length > 0) {
          const maxWidth = staffCol.width - 2;
          let totalLines = 0;
          // Calculer le nombre de lignes pour chaque élément (chaque élément sur sa propre ligne)
          staffParts.forEach((item) => {
            const wrappedLines = doc.splitTextToSize(item, maxWidth);
            totalLines += wrappedLines.length;
          });
          if (totalLines > 1) {
            rowHeight = Math.max(rowHeight, baseRowHeight + (totalLines - 1) * 3.5);
          }
        }
      }

      // Calculer la hauteur pour Contacts
      const contactsCol = columns.find(col => col.key === 'contacts');
      if (contactsCol && extras) {
        const contactParts: string[] = [];
        if (extras.arbitreTouche) {
          if (Array.isArray(extras.arbitreTouche)) {
            extras.arbitreTouche.forEach((a) => {
              contactParts.push(`Arb touche: ${a.nom}${a.numero ? ` (${a.numero})` : ''}`);
            });
          } else if (typeof extras.arbitreTouche === 'object' && 'nom' in extras.arbitreTouche) {
            const a = extras.arbitreTouche as { nom: string; numero?: string };
            contactParts.push(`Arb touche: ${a.nom}${a.numero ? ` (${a.numero})` : ''}`);
          }
        }
        if (extras.contactEncadrants && Array.isArray(extras.contactEncadrants)) {
          extras.contactEncadrants.forEach((c) => {
            contactParts.push(`Enc: ${c.nom}${c.numero ? ` (${c.numero})` : ''}`);
          });
        }
        if (extras.contactAccompagnateur && Array.isArray(extras.contactAccompagnateur)) {
          extras.contactAccompagnateur.forEach((c) => {
            contactParts.push(`Acc: ${c.nom}${c.numero ? ` (${c.numero})` : ''}`);
          });
        }
        if (contactParts.length > 0) {
          const maxWidth = contactsCol.width - 2;
          let totalLines = 0;
          // Calculer le nombre de lignes pour chaque élément (chaque élément sur sa propre ligne)
          contactParts.forEach((item) => {
            const wrappedLines = doc.splitTextToSize(item, maxWidth);
            totalLines += wrappedLines.length;
          });
          if (totalLines > 1) {
            rowHeight = Math.max(rowHeight, baseRowHeight + (totalLines - 1) * 3.5);
          }
        }
      }

      // Vérifier si on dépasse la hauteur disponible de la page
      // Si oui, créer une nouvelle page et réafficher l'en-tête du tableau
      if (yPosition + rowHeight > pageHeight - margin) {
        doc.addPage();
        yPosition = margin;

        // Réafficher le titre du tableau sur la nouvelle page
        doc.setTextColor(palette.primary[0], palette.primary[1], palette.primary[2]);
        doc.setFontSize(11);
        doc.setFont('helvetica', 'bold');
        doc.text(`Planning du ${dateFormatted} (suite)`, margin, yPosition);
        yPosition += 5;

        // Réafficher l'en-tête du tableau
        doc.setFillColor(palette.primary[0], palette.primary[1], palette.primary[2]);
        doc.rect(margin, yPosition, contentWidth, headerRowHeight, 'F');

        doc.setTextColor(palette.headerText[0], palette.headerText[1], palette.headerText[2]);
        doc.setFontSize(8);
        doc.setFont('helvetica', 'bold');

        xPos = margin + 1;
        columns.forEach((col) => {
          const label = col.label.length > 15 ? col.label.substring(0, 13) + '...' : col.label;
          doc.text(label, xPos, yPosition + 5);
          xPos += col.width;
        });

        yPosition += headerRowHeight;
        rowIndex = 0; // Réinitialiser l'index pour les couleurs alternées
      }

      // Fond alterné teinté avec la couleur secondaire du club
      if (rowIndex % 2 === 0) {
        doc.setFillColor(palette.altRow[0], palette.altRow[1], palette.altRow[2]);
        doc.rect(margin, yPosition, contentWidth, rowHeight, 'F');
      }

      // Déterminer le type d'événement
      let eventType: string;
      if ('type' in event && event.type) {
        eventType = event.type;
      } else if ('localTeam' in event || 'competition' in event) {
        eventType = match.type === 'amical' ? 'amical' : 'officiel';
      } else if ('lieu' in event) {
        const simpleEvent = event as Entrainement | Plateau;
        eventType = simpleEvent.type;
      } else {
        eventType = 'inconnu';
      }

      const typeLabels: Record<string, string> = {
        officiel: 'Officiel',
        amical: 'Amical',
        entrainement: 'Entraînement',
        plateau: 'Plateau',
      };

      // Afficher les valeurs
      doc.setTextColor(palette.bodyText[0], palette.bodyText[1], palette.bodyText[2]);
      doc.setFontSize(7);
      doc.setFont('helvetica', 'normal');

      xPos = margin + 1;
      const currentY = yPosition + 5.5; // Position Y de base pour le texte

      columns.forEach((col) => {
        let value = '';
        let isMultiLine = false;
        let colAddressLines: string[] = [];

        switch (col.key) {
          case 'heure':
            value = 'time' in event ? event.time : '';
            break;
          case 'horaireRdv':
            if ('horaireRendezVous' in event) {
              value = (event as Match).horaireRendezVous || '';
            }
            break;
          case 'competition':
            if ('competition' in event) {
              value = (event as Match).competition || '';
            } else if ('lieu' in event) {
              // Pour les entraînements/plateaux, mettre le type
              value = typeLabels[eventType] || eventType;
            }
            break;
          case 'equipeLocale':
            if ('localTeam' in event) {
              value = (event as Match).localTeam || '';
            } else if ('lieu' in event) {
              // Pour les entraînements/plateaux, mettre le lieu
              value = (event as Entrainement | Plateau).lieu || '';
            }
            break;
          case 'equipeVisiteur':
            if ('awayTeam' in event) {
              value = (event as Match).awayTeam || '';
            }
            break;
          case 'adresse':
            if ('details' in event && event.details) {
              const stadium = event.details.stadium || '';
              const address = event.details.address || '';
              if (stadium && address) {
                value = `${stadium}, ${address}`;
              } else {
                value = stadium || address;
              }
            }
            // Utiliser les lignes pré-calculées pour l'adresse
            colAddressLines = addressLines;
            if (addressLines.length > 0) {
              isMultiLine = true;
            }
            break;
          case 'staff':
            // Staff depuis matches.json uniquement
            const staffParts: string[] = [];
            if ('staff' in event && event.staff) {
              if (event.staff.referee) {
                staffParts.push(`Arb Off: ${event.staff.referee}`);
              }
              if (event.staff.assistant1) {
                staffParts.push(`Asst1: ${event.staff.assistant1}`);
              }
              if (event.staff.assistant2) {
                staffParts.push(`Asst2: ${event.staff.assistant2}`);
              }
            }
            value = staffParts.join('\n');
            break;
          case 'contacts':
            // Contacts depuis matches-extras.json uniquement
            const contactParts: string[] = [];

            // Arbitres AFP (depuis matches-extras.json)
            if (extras?.arbitreTouche) {
              if (Array.isArray(extras.arbitreTouche)) {
                extras.arbitreTouche.forEach((a) => {
                  contactParts.push(`Arb touche: ${a.nom}${a.numero ? ` (${a.numero})` : ''}`);
                });
              } else if (typeof extras.arbitreTouche === 'object' && 'nom' in extras.arbitreTouche) {
                const a = extras.arbitreTouche as { nom: string; numero?: string };
                contactParts.push(`Arb touche: ${a.nom}${a.numero ? ` (${a.numero})` : ''}`);
              }
            }

            // Encadrants (depuis matches-extras.json uniquement)
            if (extras?.contactEncadrants && Array.isArray(extras.contactEncadrants)) {
              extras.contactEncadrants.forEach((c) => {
                contactParts.push(`Enc: ${c.nom}${c.numero ? ` (${c.numero})` : ''}`);
              });
            }

            // Accompagnateurs (depuis matches-extras.json uniquement)
            if (extras?.contactAccompagnateur && Array.isArray(extras.contactAccompagnateur)) {
              extras.contactAccompagnateur.forEach((c) => {
                contactParts.push(`Acc: ${c.nom}${c.numero ? ` (${c.numero})` : ''}`);
              });
            }

            value = contactParts.join('\n');
            break;
        }

        // Afficher le texte
        if (col.key === 'adresse' && isMultiLine && colAddressLines.length > 0) {
          // Afficher l'adresse sur plusieurs lignes
          colAddressLines.forEach((line, lineIndex) => {
            doc.text(line, xPos, currentY + (lineIndex * 3.5));
          });
        } else if ((col.key === 'staff' || col.key === 'contacts') && value) {
          // Afficher Staff et Contacts sur plusieurs lignes (chaque élément sur sa propre ligne)
          const maxWidth = col.width - 2;
          // Diviser d'abord par les sauts de ligne
          const items = value.split('\n');
          let lineOffset = 0;
          items.forEach((item) => {
            // Si un item est trop long, le diviser en plusieurs lignes
            const wrappedLines = doc.splitTextToSize(item, maxWidth);
            wrappedLines.forEach((line: string, lineIndex: number) => {
              doc.text(line, xPos, currentY + (lineOffset + lineIndex) * 3.5);
            });
            lineOffset += wrappedLines.length;
          });
        } else {
          // Tronquer le texte si nécessaire pour les autres colonnes
          const maxWidth = col.width - 2;
          const lines = doc.splitTextToSize(value || '', maxWidth);
          const displayText = lines.length > 1 ? lines[0] + '...' : lines[0] || '';
          doc.text(displayText, xPos, currentY);
        }

        doc.setFont('helvetica', 'normal'); // Réinitialiser la police
        xPos += col.width;
      });

      yPosition += rowHeight;
      rowIndex++;
    });
  });

  // Ajouter les abréviations sur une seule ligne après le dernier tableau
  // Vérifier si on a besoin d'une nouvelle page
  if (yPosition + 8 > pageHeight - margin) {
    doc.addPage();
    yPosition = margin;
  } else {
    yPosition += 5; // Espacement après le tableau
  }

  // Liste des abréviations
  const abbreviations = [
    { abbr: 'Arb Off', full: 'Arbitre Officiel' },
    { abbr: 'Asst1', full: 'Assistant 1' },
    { abbr: 'Asst2', full: 'Assistant 2' },
    { abbr: 'Arb touche', full: 'Arbitre touche' },
    { abbr: 'Enc', full: 'Encadrant' },
    { abbr: 'Acc', full: 'Accompagnateur' },
  ];

  // Construire le texte sur une seule ligne
  const abbreviationsText = abbreviations
    .map((item) => `${item.abbr}: ${item.full}`)
    .join(' - ');

  doc.setTextColor(palette.bodyText[0], palette.bodyText[1], palette.bodyText[2]);
  doc.setFontSize(7);
  doc.setFont('helvetica', 'normal');

  // Diviser le texte si nécessaire pour tenir dans la largeur de la page
  const maxWidth = contentWidth;
  const lines = doc.splitTextToSize(abbreviationsText, maxWidth);

  lines.forEach((line: string) => {
    if (yPosition + 5 > pageHeight - margin) {
      doc.addPage();
      yPosition = margin;
    }
    doc.text(line, margin, yPosition);
    yPosition += 4;
  });

  // Générer le nom du fichier
  const fileName = `export-matches-${new Date().toISOString().split('T')[0]}.pdf`;

  // Télécharger le PDF
  doc.save(fileName);
}
