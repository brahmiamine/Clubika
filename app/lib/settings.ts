import { ClubInfo } from '@/types/match';

export type ThemeMode = 'light' | 'dark' | 'system';

export interface PlanningFeatureFlags {
    assignmentValidation: boolean;
    publicationReadiness: boolean;
    autoAssignment: boolean;
    automaticReminders: boolean;
    assignmentSwaps: boolean;
    attendanceTracking: boolean;
    recurringEvents: boolean;
    publicSharing: boolean;
    scraperSync: boolean;
    /** N’affiche les matchs officiels scrapés que sur le week-end en cours (samedi–dimanche). */
    officialMatchesCurrentWeekendOnly: boolean;
    eventChat: boolean;
    travelAndWeather: boolean;
    calendarExport: boolean;
    collaboration: boolean;
    requireArbitreForPublication: boolean;
    requireEncadrantForPublication: boolean;
    requireAccompagnateurForPublication: boolean;
}

export interface SmtpSettings {
    host: string;
    port: number | null;
    secure: boolean;
    user: string;
    fromEmail: string;
    fromName: string;
    /** Vrai si un mot de passe SMTP est enregistré (jamais renvoyé en clair). */
    passwordSet: boolean;
}

export interface AppSettings {
    clubName: string;
    clubAbbreviation: string;
    clubDescription: string;
    clubLogo: string;
    matchesUrlKey: string;
    scraperClubName: string;
    themeMode: ThemeMode;
    primaryColor: string;
    accentColor: string;
    timeZone: string;
    smtp: SmtpSettings;
    features: PlanningFeatureFlags;
}

export const DEFAULT_PLANNING_FEATURES: PlanningFeatureFlags = {
    assignmentValidation: true,
    publicationReadiness: false,
    autoAssignment: true,
    automaticReminders: true,
    assignmentSwaps: true,
    attendanceTracking: true,
    recurringEvents: true,
    publicSharing: true,
    scraperSync: true,
    officialMatchesCurrentWeekendOnly: true,
    eventChat: true,
    travelAndWeather: true,
    calendarExport: true,
    collaboration: true,
    requireArbitreForPublication: true,
    requireEncadrantForPublication: true,
    requireAccompagnateurForPublication: true,
};

export const DEFAULT_SMTP_SETTINGS: SmtpSettings = {
    host: '',
    port: null,
    secure: false,
    user: '',
    fromEmail: '',
    fromName: '',
    passwordSet: false,
};

export const DEFAULT_APP_SETTINGS: AppSettings = {
    clubName: 'Academie Football Paris 18',
    clubAbbreviation: 'AFP',
    clubDescription: 'Club de Football à Paris 18',
    clubLogo: '',
    matchesUrlKey: 'academie-football-paris-18',
    scraperClubName: '',
    themeMode: 'system',
    primaryColor: '#003287',
    accentColor: '#e3ebf7',
    timeZone: 'Europe/Paris',
    smtp: DEFAULT_SMTP_SETTINGS,
    features: DEFAULT_PLANNING_FEATURES,
};

export const APP_SETTINGS_META_KEY = 'app_settings_v1';

/** Champs que l’admin club peut écrire via PUT /api/settings. Le scraping reste exclusif à /plateforme. */
export const CLUB_WRITABLE_SETTING_KEYS = [
    'clubName',
    'clubAbbreviation',
    'clubDescription',
    'clubLogo',
    'themeMode',
    'primaryColor',
    'accentColor',
    'timeZone',
    'smtp',
    'features',
] as const;

export type ClubWritableSettingKey = (typeof CLUB_WRITABLE_SETTING_KEYS)[number];

export function pickClubWritableSettings(
    input: Partial<AppSettings>,
): Pick<AppSettings, ClubWritableSettingKey> {
    const picked = {} as Pick<AppSettings, ClubWritableSettingKey>;
    for (const key of CLUB_WRITABLE_SETTING_KEYS) {
        if (input[key] !== undefined) {
            (picked as Record<string, unknown>)[key] = input[key];
        }
    }
    return picked;
}

function isThemeMode(value: unknown): value is ThemeMode {
    return value === 'light' || value === 'dark' || value === 'system';
}

function toStringValue(value: unknown, fallback: string): string {
    if (typeof value !== 'string') {
        return fallback;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : fallback;
}

/**
 * Abréviation du club (ex. « AFP ») : espaces normalisés, longueur bornée.
 * Une chaîne explicitement vide est conservée pour laisser la configuration
 * signaler le champ comme requis ; un champ absent retombe sur la valeur par défaut.
 */
function normalizeAbbreviation(value: unknown, fallback: string): string {
    if (typeof value !== 'string') {
        return fallback;
    }
    return value.trim().replace(/\s+/g, ' ').slice(0, 16);
}

function normalizeMatchesUrlKey(value: unknown, fallback: string): string {
    if (typeof value !== 'string') {
        return fallback;
    }

    const trimmed = value.trim();
    if (!trimmed) {
        return fallback;
    }

    const clubPathPattern = /\/clubs\/([^/?#]+)/i;
    const fromPath = trimmed.match(clubPathPattern)?.[1] ?? trimmed.split('/').filter(Boolean).at(-1) ?? trimmed;

    const normalized = fromPath
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');

    return normalized || fallback;
}

function isHexColor(value: string): boolean {
    return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value);
}

function normalizeColor(value: unknown, fallback: string): string {
    if (typeof value !== 'string') {
        return fallback;
    }
    const trimmed = value.trim();
    if (!isHexColor(trimmed)) {
        return fallback;
    }
    if (trimmed.length === 4) {
        const r = trimmed[1] ?? '0';
        const g = trimmed[2] ?? '0';
        const b = trimmed[3] ?? '0';
        return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
    }
    return trimmed.toLowerCase();
}

function normalizeTimeZone(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) return DEFAULT_APP_SETTINGS.timeZone;
    const candidate = value.trim();
    try {
        new Intl.DateTimeFormat('fr-FR', { timeZone: candidate }).format();
        return candidate;
    } catch {
        return DEFAULT_APP_SETTINGS.timeZone;
    }
}

function normalizeFeatureFlags(input: unknown): PlanningFeatureFlags {
    const candidate = input && typeof input === 'object'
        ? input as Partial<Record<keyof PlanningFeatureFlags, unknown>>
        : {};
    return Object.fromEntries(
        Object.entries(DEFAULT_PLANNING_FEATURES).map(([key, fallback]) => [
            key,
            typeof candidate[key as keyof PlanningFeatureFlags] === 'boolean'
                ? candidate[key as keyof PlanningFeatureFlags]
                : fallback,
        ]),
    ) as unknown as PlanningFeatureFlags;
}

function normalizeSmtp(input: unknown, fallback: SmtpSettings): SmtpSettings {
    const candidate = input && typeof input === 'object' ? (input as Partial<SmtpSettings>) : {};
    const rawPort = candidate.port;
    const port = typeof rawPort === 'number' && Number.isInteger(rawPort) && rawPort > 0 && rawPort < 65536
        ? rawPort
        : fallback.port;
    return {
        host: toStringValue(candidate.host, fallback.host || ''),
        port,
        secure: typeof candidate.secure === 'boolean' ? candidate.secure : fallback.secure,
        user: toStringValue(candidate.user, fallback.user || ''),
        fromEmail: toStringValue(candidate.fromEmail, fallback.fromEmail || ''),
        fromName: toStringValue(candidate.fromName, fallback.fromName || ''),
        passwordSet: fallback.passwordSet,
    };
}

export function normalizeAppSettings(input: unknown): AppSettings {
    if (!input || typeof input !== 'object') {
        return DEFAULT_APP_SETTINGS;
    }

    const candidate = input as Partial<AppSettings>;

    return {
        clubName: toStringValue(candidate.clubName, DEFAULT_APP_SETTINGS.clubName),
        clubAbbreviation: normalizeAbbreviation(candidate.clubAbbreviation, DEFAULT_APP_SETTINGS.clubAbbreviation),
        clubDescription: toStringValue(candidate.clubDescription, DEFAULT_APP_SETTINGS.clubDescription),
        clubLogo: typeof candidate.clubLogo === 'string' ? candidate.clubLogo.trim() : DEFAULT_APP_SETTINGS.clubLogo,
        matchesUrlKey: normalizeMatchesUrlKey(candidate.matchesUrlKey, DEFAULT_APP_SETTINGS.matchesUrlKey),
        scraperClubName: toStringValue(candidate.scraperClubName, DEFAULT_APP_SETTINGS.scraperClubName),
        themeMode: isThemeMode(candidate.themeMode) ? candidate.themeMode : DEFAULT_APP_SETTINGS.themeMode,
        primaryColor: normalizeColor(candidate.primaryColor, DEFAULT_APP_SETTINGS.primaryColor),
        accentColor: normalizeColor(candidate.accentColor, DEFAULT_APP_SETTINGS.accentColor),
        timeZone: normalizeTimeZone(candidate.timeZone),
        smtp: normalizeSmtp(candidate.smtp, DEFAULT_APP_SETTINGS.smtp),
        features: normalizeFeatureFlags(candidate.features),
    };
}

/**
 * Libellé d'un rôle d'officiel du club suffixé de l'abréviation du club
 * (ex. « Arbitre AFP », « Encadrants AFP »). Sans abréviation, renvoie le libellé nu.
 */
export function roleLabelWithClub(base: string, abbreviation: string): string {
    const abbr = abbreviation.trim();
    return abbr ? `${base} ${abbr}` : base;
}

export function mergeClubWithSettings(baseClub: ClubInfo | undefined, settings: AppSettings): ClubInfo {
    return {
        name: settings.clubName || baseClub?.name || DEFAULT_APP_SETTINGS.clubName,
        description: settings.clubDescription || baseClub?.description || DEFAULT_APP_SETTINGS.clubDescription,
        logo: settings.clubLogo || baseClub?.logo || '',
    };
}

function getLuminance(hexColor: string): number {
    const hex = hexColor.replace('#', '');
    const normalizedHex = hex.length === 3
        ? `${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`
        : hex;

    const r = Number.parseInt(normalizedHex.slice(0, 2), 16) / 255;
    const g = Number.parseInt(normalizedHex.slice(2, 4), 16) / 255;
    const b = Number.parseInt(normalizedHex.slice(4, 6), 16) / 255;

    const toLinear = (channel: number) =>
        channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;

    return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function getReadableForeground(hexColor: string): string {
    return getLuminance(hexColor) > 0.5 ? '#111827' : '#f9fafb';
}

const THEME_USER_OVERRIDE_KEY = 'app_theme_user_override';

/** Marque le thème comme choisi manuellement par l'utilisateur (via le bouton bascule). */
export function markThemeUserOverride(): void {
    if (typeof window === 'undefined') {
        return;
    }
    try {
        localStorage.setItem(THEME_USER_OVERRIDE_KEY, '1');
    } catch {
        // Stockage indisponible : on ignore, le réglage du club s'appliquera.
    }
}

/** Vrai si l'utilisateur a choisi manuellement son thème (le réglage club ne doit pas l'écraser). */
export function hasThemeUserOverride(): boolean {
    if (typeof window === 'undefined') {
        return false;
    }
    try {
        return localStorage.getItem(THEME_USER_OVERRIDE_KEY) === '1';
    } catch {
        return false;
    }
}

/**
 * Enregistre un choix de thème utilisateur et l'applique.
 * À utiliser depuis le menu mobile comme depuis le bouton desktop : sans ce
 * marqueur, `AppThemeSync` réappliquerait le themeMode du club (souvent sombre)
 * dès le prochain chargement des réglages.
 */
export function applyUserThemeChoice(
    theme: ThemeMode,
    setTheme: (theme: ThemeMode) => void,
): void {
    markThemeUserOverride();
    setTheme(theme);
}

export function applyThemeVariables(settings: AppSettings): void {
    if (typeof window === 'undefined') {
        return;
    }

    const rootStyle = document.documentElement.style;
    const primary = normalizeColor(settings.primaryColor, DEFAULT_APP_SETTINGS.primaryColor);
    const accent = normalizeColor(settings.accentColor, DEFAULT_APP_SETTINGS.accentColor);

    const primaryForeground = getReadableForeground(primary);
    const accentForeground = getReadableForeground(accent);

    rootStyle.setProperty('--primary', primary);
    rootStyle.setProperty('--ring', primary);
    rootStyle.setProperty('--sidebar-primary', primary);
    rootStyle.setProperty('--primary-foreground', primaryForeground);
    rootStyle.setProperty('--sidebar-primary-foreground', primaryForeground);

    rootStyle.setProperty('--accent', accent);
    rootStyle.setProperty('--sidebar-accent', accent);
    rootStyle.setProperty('--accent-foreground', accentForeground);

    // La « couleur secondaire » du club pilote aussi le token `--secondary` : les
    // boutons/badges `variant="secondary"` et toute utilité `bg-secondary` portent
    // alors l'identité visuelle du club. `--primary-soft` / `--secondary-soft` sont
    // dérivés en CSS (globals.css) et se recalculent automatiquement.
    rootStyle.setProperty('--secondary', accent);
    rootStyle.setProperty('--secondary-foreground', accentForeground);
    rootStyle.setProperty('--sidebar-accent-foreground', accentForeground);
}

/**
 * Applique la palette PROPRE À L'APPLICATION (couleurs primaire/secondaire par
 * défaut de Clubika), indépendante de tout club. À utiliser sur les écrans
 * hors session — connexion, mot de passe oublié, réinitialisation,
 * landing, back-office plateforme : `/login` est l'entrée commune de toute la
 * plateforme et ne doit jamais porter l'identité couleur d'un club.
 */
export function applyDefaultThemeVariables(): void {
    applyThemeVariables(DEFAULT_APP_SETTINGS);
}
