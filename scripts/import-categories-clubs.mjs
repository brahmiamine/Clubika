import fs from 'node:fs';
import path from 'node:path';
import * as mariadb from 'mariadb';

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function parseDotEnv(content) {
  const parsed = {};
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const equalIndex = trimmed.indexOf('=');
    if (equalIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, equalIndex).trim();
    let value = trimmed.slice(equalIndex + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (key) {
      parsed[key] = value;
    }
  }

  return parsed;
}

function loadLocalEnv() {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) {
    return {};
  }

  return parseDotEnv(fs.readFileSync(envPath, 'utf8'));
}

function normalize(value) {
  return value.trim().toLowerCase();
}

async function main() {
  const env = loadLocalEnv();
  const getEnv = (key, fallback) => process.env[key] ?? env[key] ?? fallback;

  const dbConfig = {
    host: getEnv('DB_HOST', '127.0.0.1'),
    port: Number.parseInt(getEnv('DB_PORT', '3306'), 10),
    user: getEnv('DB_USER', 'clubika_user'),
    password: getEnv('DB_PASSWORD', 'clubika_password'),
    database: getEnv('DB_NAME', 'clubika'),
    charset: 'utf8mb4',
  };

  const categoriesFile = path.join(process.cwd(), 'data', 'categories.json');
  const clubsFile = path.join(process.cwd(), 'data', 'clubs.json');

  const categoriesJson = readJson(categoriesFile, { categories: [] });
  const clubsJson = readJson(clubsFile, []);

  const uniqueCategories = new Map();
  for (const raw of categoriesJson.categories ?? []) {
    if (typeof raw !== 'string' || !raw.trim()) {
      continue;
    }
    const value = raw.trim();
    uniqueCategories.set(normalize(value), value);
  }

  const uniqueClubs = new Map();
  for (const club of clubsJson) {
    if (typeof club?.nom !== 'string' || typeof club?.logo !== 'string') {
      continue;
    }

    const nom = club.nom.trim();
    const logo = club.logo.trim();
    if (!nom || !logo) {
      continue;
    }

    uniqueClubs.set(normalize(nom), { nom, logo });
  }

  let connection;
  try {
    connection = await mariadb.createConnection(dbConfig);

    await connection.beginTransaction();

    for (const value of uniqueCategories.values()) {
      await connection.query(
        `INSERT INTO categories (value, createdAt, updatedAt)
         VALUES (?, NOW(6), NOW(6))
         ON DUPLICATE KEY UPDATE updatedAt = NOW(6)`,
        [value],
      );
    }

    for (const club of uniqueClubs.values()) {
      await connection.query(
        `INSERT INTO clubs (nom, logo, createdAt, updatedAt)
         VALUES (?, ?, NOW(6), NOW(6))
         ON DUPLICATE KEY UPDATE logo = VALUES(logo), updatedAt = NOW(6)`,
        [club.nom, club.logo],
      );
    }

    await connection.commit();

    console.log(`Import terminé: ${uniqueCategories.size} catégories et ${uniqueClubs.size} clubs traités.`);
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch {
      }
    }

    console.error('Erreur import categories/clubs:', error);
    process.exitCode = 1;
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}

await main();
