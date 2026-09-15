import { randomBytes } from 'node:crypto';
import type { DataSource } from 'typeorm';
import type { UserEntity } from '@/lib/db/schemas';
import { hashPassword } from '@/lib/auth/password';
import { generatePlaceholderEmail } from '@/lib/auth/placeholder-account';
import { normalizePlanningFunctions } from '@/lib/auth/roles';
import {
  CATEGORY_PLANNING_FUNCTION,
  ContactLifecycleError,
  type ContactCategory,
} from './constants';
import { parseCategory, parseProvenance, parsePurpose, upsertContactMeta } from './meta';
import { assertTelephoneAllowed } from './meta';
import { normalizeTelephone } from './meta';

export interface CsvImportRefused {
  line: number;
  error: string;
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/^\ufeff/, '');
}

export function parseContactCsv(raw: string): Array<{ line: number; values: Record<string, string> }> {
  const lines = raw.split(/\r?\n/);
  let header: string[] | null = null;
  const records: Array<{ line: number; values: Record<string, string> }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const cells = splitCsvLine(line);
    if (!header) {
      header = cells.map(normalizeHeader);
      continue;
    }
    const values: Record<string, string> = {};
    header.forEach((key, index) => {
      values[key] = cells[index] ?? '';
    });
    records.push({ line: i + 1, values });
  }
  return records;
}

function csvError(error: unknown): string {
  if (error instanceof ContactLifecycleError) {
    if (error.message.includes('Provenance inconnue')) return 'provenance_inconnue';
    if (error.message.includes('téléphone')) return 'telephone_sans_provenance';
    if (error.message.includes('Catégorie')) return 'categorie_inconnue';
    if (error.message.includes('Finalité')) return 'finalite_inconnue';
  }
  return 'ligne_invalide';
}

export async function importContactCsv(
  db: DataSource,
  clubId: string,
  recordedByUserId: number,
  raw: string,
): Promise<{ accepted: number; refused: CsvImportRefused[] }> {
  const records = parseContactCsv(raw);
  const refused: CsvImportRefused[] = [];
  let accepted = 0;
  const repo = db.getRepository<UserEntity>('User');
  const clubUsers = await repo.find({ where: { clubId } });

  for (const record of records) {
    try {
      const nom = record.values.nom?.trim() ?? '';
      if (!nom) {
        refused.push({ line: record.line, error: 'nom_absent' });
        continue;
      }
      const provenanceRaw = record.values.provenance?.trim() ?? '';
      if (!provenanceRaw) {
        refused.push({ line: record.line, error: 'provenance_absente' });
        continue;
      }
      const provenance = parseProvenance(provenanceRaw);
      const purpose = parsePurpose(record.values.purpose);
      const category: ContactCategory = parseCategory(record.values.category);
      const telephone = normalizeTelephone(record.values.telephone);
      assertTelephoneAllowed({ telephone, provenance, existingProvenance: null });

      const planningFunction = CATEGORY_PLANNING_FUNCTION[category];
      const duplicate = clubUsers.find((user) => (
        user.nom.trim().toLowerCase() === nom.toLowerCase()
        && normalizePlanningFunctions(user.planningFunctions).includes(planningFunction)
      ));
      if (duplicate) {
        refused.push({ line: record.line, error: 'doublon' });
        continue;
      }

      const email = await generatePlaceholderEmail(db, nom, category);
      const passwordHash = await hashPassword(randomBytes(24).toString('hex'));
      const saved = await repo.save({
        clubId,
        email,
        passwordHash,
        nom,
        accessRole: 'dirigeant',
        planningFunctions: [planningFunction],
        active: true,
        claimedAt: null,
        telephone,
        indisponibilites: null,
        icalToken: randomBytes(24).toString('hex'),
      });
      clubUsers.push(saved);
      await upsertContactMeta(db, {
        userId: saved.id,
        clubId,
        category,
        provenance,
        purpose,
        recordedByUserId,
      });
      accepted += 1;
    } catch (error) {
      refused.push({ line: record.line, error: csvError(error) });
    }
  }

  return { accepted, refused };
}
