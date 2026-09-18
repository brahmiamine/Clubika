import type { AppSettings, PlanningFeatureFlags, SmtpSettings, ThemeMode } from '@/lib/settings';

/** Branding only — never derived by spreading, omitting, or blacklisting AppSettings. */
export type PublicClubSettings = {
  clubName: string;
  primaryColor: string;
  accentColor: string;
  clubLogo: string;
};

/** Authenticated non-admin payload: in-app UI needs features and labels, never SMTP. */
export type MemberClubSettings = {
  clubName: string;
  clubAbbreviation: string;
  clubDescription: string;
  clubLogo: string;
  primaryColor: string;
  accentColor: string;
  themeMode: ThemeMode;
  timeZone: string;
  features: PlanningFeatureFlags;
};

export type AdminSmtpSettings = {
  host: string;
  port: SmtpSettings['port'];
  secure: boolean;
  user: string;
  fromEmail: string;
  fromName: string;
  passwordSet: boolean;
};

/** Admin payload: writable club settings plus SMTP metadata, never the SMTP password. */
export type AdminClubSettings = MemberClubSettings & {
  smtp: AdminSmtpSettings;
};

const ALLOWED_DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,/i;

export const PUBLIC_CLUB_SETTINGS_KEYS = [
  'clubName',
  'primaryColor',
  'accentColor',
  'clubLogo',
] as const;

/** Keys that must never appear on the unauthenticated settings response. */
export const FORBIDDEN_PUBLIC_SETTINGS_KEYS = [
  'smtp',
  'host',
  'port',
  'secure',
  'user',
  'password',
  'passwordSet',
  'fromEmail',
  'fromName',
  'features',
  'themeMode',
  'timeZone',
  'matchesUrlKey',
  'scraperClubName',
  'clubAbbreviation',
  'clubDescription',
  'travelAndWeather',
  'volunteerShifts',
  'whatsapp',
  'assignmentValidation',
  'publicationReadiness',
  'scraperSync',
  'eventChat',
] as const;

/**
 * Public club logos must be empty, same-origin, or an uploaded data:image.
 * Remote URLs (third-party CDNs, etc.) are stripped.
 */
export function sanitizePublicClubLogo(raw: string): string {
  const value = raw.trim();
  if (!value) return '';
  if (value.startsWith('/') && !value.startsWith('//')) return value;
  if (ALLOWED_DATA_IMAGE.test(value)) return value;
  return '';
}

function toPlanningFeatureFlags(features: PlanningFeatureFlags): PlanningFeatureFlags {
  return {
    assignmentValidation: features.assignmentValidation,
    publicationReadiness: features.publicationReadiness,
    autoAssignment: features.autoAssignment,
    automaticReminders: features.automaticReminders,
    assignmentSwaps: features.assignmentSwaps,
    attendanceTracking: features.attendanceTracking,
    recurringEvents: features.recurringEvents,
    publicSharing: features.publicSharing,
    scraperSync: features.scraperSync,
    officialMatchesCurrentWeekendOnly: features.officialMatchesCurrentWeekendOnly,
    eventChat: features.eventChat,
    travelAndWeather: features.travelAndWeather,
    calendarExport: features.calendarExport,
    collaboration: features.collaboration,
    requireArbitreForPublication: features.requireArbitreForPublication,
    requireEncadrantForPublication: features.requireEncadrantForPublication,
    requireAccompagnateurForPublication: features.requireAccompagnateurForPublication,
    massExport: features.massExport,
  };
}

export function toPublicClubSettings(settings: AppSettings): PublicClubSettings {
  return {
    clubName: settings.clubName,
    primaryColor: settings.primaryColor,
    accentColor: settings.accentColor,
    clubLogo: sanitizePublicClubLogo(settings.clubLogo),
  };
}

export function toMemberClubSettings(settings: AppSettings): MemberClubSettings {
  return {
    clubName: settings.clubName,
    clubAbbreviation: settings.clubAbbreviation,
    clubDescription: settings.clubDescription,
    clubLogo: settings.clubLogo,
    primaryColor: settings.primaryColor,
    accentColor: settings.accentColor,
    themeMode: settings.themeMode,
    timeZone: settings.timeZone,
    features: toPlanningFeatureFlags(settings.features),
  };
}

export function toAdminClubSettings(settings: AppSettings): AdminClubSettings {
  return {
    clubName: settings.clubName,
    clubAbbreviation: settings.clubAbbreviation,
    clubDescription: settings.clubDescription,
    clubLogo: settings.clubLogo,
    primaryColor: settings.primaryColor,
    accentColor: settings.accentColor,
    themeMode: settings.themeMode,
    timeZone: settings.timeZone,
    features: toPlanningFeatureFlags(settings.features),
    smtp: {
      host: settings.smtp.host,
      port: settings.smtp.port,
      secure: settings.smtp.secure,
      user: settings.smtp.user,
      fromEmail: settings.smtp.fromEmail,
      fromName: settings.smtp.fromName,
      passwordSet: settings.smtp.passwordSet,
    },
  };
}
