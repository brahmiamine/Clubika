export type OfficielIndisponibiliteType = 'day-range' | 'time-slot';
export type IndispoReviewStatus = 'pending' | 'accepted' | 'rejected';

export interface OfficielIndisponibilite {
    id: string;
    type: OfficielIndisponibiliteType;
    dateStart?: string;
    dateEnd?: string;
    date?: string;
    startTime?: string;
    endTime?: string;
    /**
     * Validation administrateur (issue #322). Les enregistrements historiques sans
     * statut sont traités comme `accepted` : ils bloquent déjà le planning.
     * Une nouvelle demande passe en `pending`, qui bloque aussi jusqu'au refus.
     */
    status?: IndispoReviewStatus;
    createdAt?: string;
    reviewedAt?: string;
    reviewedByUserId?: number;
    /** Texte libre historique — ne plus écrire ni exposer (issue #7). */
    reviewComment?: string;
    /** Motif de refus administratif structuré, non médical (issue #7). */
    reviewCode?: 'schedule_too_broad' | 'conflict' | 'insufficient_notice' | 'other';
}

export interface OfficielWithDisponibilites {
    nom: string;
    indisponibilites?: OfficielIndisponibilite[];
}

interface AvailabilityStatus {
    unavailable: boolean;
    reason: 'day-range' | 'time-slot' | null;
    blockLevel: 'day' | 'time' | null;
    message?: string;
    rule?: OfficielIndisponibilite;
}

function pad2(value: number): string {
    return String(value).padStart(2, '0');
}

export function normalizeDateValue(date: string): string | null {
    const trimmed = date.trim();

    const slashMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (slashMatch) {
        const day = Number.parseInt(slashMatch[1] ?? '', 10);
        const month = Number.parseInt(slashMatch[2] ?? '', 10);
        const year = Number.parseInt(slashMatch[3] ?? '', 10);
        if (!Number.isFinite(day) || !Number.isFinite(month) || !Number.isFinite(year)) {
            return null;
        }
        if (day < 1 || day > 31 || month < 1 || month > 12) {
            return null;
        }
        return `${pad2(day)}/${pad2(month)}/${year}`;
    }

    const dashMatch = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (dashMatch) {
        const year = Number.parseInt(dashMatch[1] ?? '', 10);
        const month = Number.parseInt(dashMatch[2] ?? '', 10);
        const day = Number.parseInt(dashMatch[3] ?? '', 10);
        if (!Number.isFinite(day) || !Number.isFinite(month) || !Number.isFinite(year)) {
            return null;
        }
        if (day < 1 || day > 31 || month < 1 || month > 12) {
            return null;
        }
        return `${pad2(day)}/${pad2(month)}/${year}`;
    }

    return null;
}

export function toDateKeyFromInput(inputDate: string): string {
    return normalizeDateValue(inputDate) ?? '';
}

export function toInputDateFromDateKey(dateKey: string): string {
    const normalized = normalizeDateValue(dateKey);
    if (!normalized) {
        return '';
    }
    const [day, month, year] = normalized.split('/');
    return `${year}-${month}-${day}`;
}

export function extractMinutes(rawTime?: string): number | null {
    if (!rawTime) {
        return null;
    }

    const match = rawTime.match(/(\d{1,2})[:hH](\d{2})/);
    if (!match) {
        return null;
    }

    const hours = Number.parseInt(match[1] ?? '', 10);
    const minutes = Number.parseInt(match[2] ?? '', 10);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
        return null;
    }

    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
        return null;
    }

    return hours * 60 + minutes;
}

export function dateKeyToComparable(dateKey: string): number | null {
    const normalized = normalizeDateValue(dateKey);
    if (!normalized) {
        return null;
    }
    const [day, month, year] = normalized.split('/').map((part) => Number.parseInt(part, 10));
    if (!day || !month || !year) {
        return null;
    }
    return year * 10000 + month * 100 + day;
}

function normalizeTimeValue(rawTime?: string): string | undefined {
    if (!rawTime) {
        return undefined;
    }
    const minutes = extractMinutes(rawTime);
    if (minutes === null) {
        return undefined;
    }
    const hoursPart = Math.floor(minutes / 60);
    const minutesPart = minutes % 60;
    return `${pad2(hoursPart)}:${pad2(minutesPart)}`;
}

function reviewFieldsFromCandidate(candidate: Partial<OfficielIndisponibilite>): Partial<OfficielIndisponibilite> {
    const fields: Partial<OfficielIndisponibilite> = {};
    if (candidate.status === 'pending' || candidate.status === 'accepted' || candidate.status === 'rejected') {
        fields.status = candidate.status;
    }
    if (typeof candidate.createdAt === 'string' && candidate.createdAt.trim()) {
        fields.createdAt = candidate.createdAt.trim();
    }
    if (typeof candidate.reviewedAt === 'string' && candidate.reviewedAt.trim()) {
        fields.reviewedAt = candidate.reviewedAt.trim();
    }
    if (typeof candidate.reviewedByUserId === 'number' && Number.isInteger(candidate.reviewedByUserId) && candidate.reviewedByUserId > 0) {
        fields.reviewedByUserId = candidate.reviewedByUserId;
    }
    if (typeof candidate.reviewComment === 'string' && candidate.reviewComment.trim()) {
        fields.reviewComment = candidate.reviewComment.trim();
    }
    if (
      candidate.reviewCode === 'schedule_too_broad'
      || candidate.reviewCode === 'conflict'
      || candidate.reviewCode === 'insufficient_notice'
      || candidate.reviewCode === 'other'
    ) {
        fields.reviewCode = candidate.reviewCode;
    }
    return fields;
}

/** Une indisponibilité `pending` ou `accepted` (y compris l'historique sans statut) bloque l'affectation. */
export function indispoBlocksPlanning(rule: OfficielIndisponibilite): boolean {
    return rule.status !== 'rejected';
}

function generateRuleId(rule: Partial<OfficielIndisponibilite>, index: number): string {
    const dateStart = rule.dateStart ?? rule.date ?? 'date-start';
    const dateEnd = rule.dateEnd ?? rule.date ?? 'date-end';
    const type = rule.type ?? 'day-range';
    const start = rule.startTime ?? 'start';
    const end = rule.endTime ?? 'end';
    return `${type}-${dateStart}-${dateEnd}-${start}-${end}-${index}`;
}

export function normalizeIndisponibilites(input: unknown): OfficielIndisponibilite[] {
    let source: unknown = input;

    if (typeof source === 'string') {
        try {
            source = JSON.parse(source) as unknown;
        } catch {
            return [];
        }
    }

    if (!Array.isArray(source)) {
        if (source && typeof source === 'object') {
            source = [source];
        } else {
            return [];
        }
    }

    if (!Array.isArray(source)) {
        return [];
    }

    const normalized: OfficielIndisponibilite[] = [];

    source.forEach((item, index) => {
        if (!item || typeof item !== 'object') {
            return;
        }

        const candidate = item as Partial<OfficielIndisponibilite>;
        const rawType = (item as { type?: unknown }).type;

        if (rawType === 'time' || rawType === 'time-slot') {
            const date = normalizeDateValue(
                typeof candidate.date === 'string'
                    ? candidate.date
                    : typeof candidate.dateStart === 'string'
                        ? candidate.dateStart
                        : '',
            );
            if (!date) {
                return;
            }

            let startTime = normalizeTimeValue(candidate.startTime);
            let endTime = normalizeTimeValue(candidate.endTime);
            if (!startTime && !endTime) {
                return;
            }

            const startMinutes = extractMinutes(startTime);
            const endMinutes = extractMinutes(endTime);
            if (startMinutes !== null && endMinutes !== null && startMinutes > endMinutes) {
                const oldStart = startTime;
                startTime = endTime;
                endTime = oldStart;
            }

            const id =
                typeof candidate.id === 'string' && candidate.id.trim().length > 0
                    ? candidate.id.trim()
                    : generateRuleId({ type: 'time-slot', date, startTime, endTime }, index);

            normalized.push({
                id,
                type: 'time-slot',
                date,
                dateStart: date,
                dateEnd: date,
                ...(startTime ? { startTime } : {}),
                ...(endTime ? { endTime } : {}),
                ...reviewFieldsFromCandidate(candidate),
            });
            return;
        }

        const rawStartDate =
            typeof candidate.dateStart === 'string'
                ? candidate.dateStart
                : typeof candidate.date === 'string'
                    ? candidate.date
                    : '';
        const rawEndDate =
            typeof candidate.dateEnd === 'string'
                ? candidate.dateEnd
                : typeof candidate.date === 'string'
                    ? candidate.date
                    : '';

        let dateStart = normalizeDateValue(rawStartDate);
        let dateEnd = normalizeDateValue(rawEndDate);

        if (!dateStart && !dateEnd) {
            return;
        }
        if (!dateStart) {
            dateStart = dateEnd;
        }
        if (!dateEnd) {
            dateEnd = dateStart;
        }

        if (!dateStart || !dateEnd) {
            return;
        }

        const startComparable = dateKeyToComparable(dateStart);
        const endComparable = dateKeyToComparable(dateEnd);
        if (startComparable !== null && endComparable !== null && startComparable > endComparable) {
            const oldStart = dateStart;
            dateStart = dateEnd;
            dateEnd = oldStart;
        }

        const id =
            typeof candidate.id === 'string' && candidate.id.trim().length > 0
                ? candidate.id.trim()
                : generateRuleId({ type: 'day-range', dateStart, dateEnd }, index);

        normalized.push({
            id,
            type: 'day-range',
            dateStart,
            dateEnd,
            ...reviewFieldsFromCandidate(candidate),
        });
    });

    const unique = new Map<string, OfficielIndisponibilite>();
    normalized.forEach((rule) => {
        const key = `${rule.type}-${rule.dateStart ?? rule.date ?? ''}-${rule.dateEnd ?? rule.date ?? ''}-${rule.startTime ?? ''}-${rule.endTime ?? ''}`;
        if (!unique.has(key)) {
            unique.set(key, rule);
        }
    });

    return Array.from(unique.values());
}

export function formatIndisponibiliteLabel(rule: OfficielIndisponibilite): string {
    if (rule.type === 'time-slot') {
        const date = rule.date ?? rule.dateStart ?? rule.dateEnd ?? '--/--/----';
        return `${date} (${rule.startTime || '--:--'} → ${rule.endTime || '--:--'})`;
    }

    const start = rule.dateStart ?? rule.date ?? '--/--/----';
    const end = rule.dateEnd ?? rule.dateStart ?? rule.date ?? '--/--/----';
    if (start === end) {
        return `${start} (journée)`;
    }
    return `Du ${start} au ${end} (journées)`;
}

export function getOfficielAvailabilityStatus(
    officiel: OfficielWithDisponibilites | null | undefined,
    eventDate: string,
    eventTime?: string,
): AvailabilityStatus {
    if (!officiel) {
        return { unavailable: false, reason: null, blockLevel: null };
    }

    const dateKey = normalizeDateValue(eventDate);
    if (!dateKey) {
        return { unavailable: false, reason: null, blockLevel: null };
    }

    const rules = normalizeIndisponibilites(officiel.indisponibilites ?? []).filter(indispoBlocksPlanning);

    const eventComparable = dateKeyToComparable(dateKey);
    if (eventComparable !== null) {
        for (const rule of rules) {
            if (rule.type !== 'day-range') {
                continue;
            }
            const dateStart = rule.dateStart ?? rule.date;
            const dateEnd = rule.dateEnd ?? rule.dateStart ?? rule.date;
            if (!dateStart || !dateEnd) {
                continue;
            }
            const startComparable = dateKeyToComparable(dateStart);
            const endComparable = dateKeyToComparable(dateEnd);
            if (startComparable === null || endComparable === null) {
                continue;
            }

            if (eventComparable >= startComparable && eventComparable <= endComparable) {
                const message =
                    dateStart === dateEnd
                        ? `${officiel.nom} est indisponible le ${dateStart}.`
                        : `${officiel.nom} est indisponible du ${dateStart} au ${dateEnd}.`;

                return {
                    unavailable: true,
                    reason: 'day-range',
                    blockLevel: 'day',
                    message,
                    rule,
                };
            }
        }
    }

    const eventMinutes = extractMinutes(eventTime);
    if (eventMinutes === null) {
        return { unavailable: false, reason: null, blockLevel: null };
    }

    for (const rule of rules) {
        const ruleDate = rule.date ?? rule.dateStart;
        if (rule.type !== 'time-slot' || ruleDate !== dateKey) {
            continue;
        }

        const startMinutes = extractMinutes(rule.startTime);
        const endMinutes = extractMinutes(rule.endTime);

        let isInside = false;
        if (startMinutes !== null && endMinutes !== null) {
            isInside = eventMinutes >= startMinutes && eventMinutes <= endMinutes;
        } else if (startMinutes !== null) {
            isInside = eventMinutes >= startMinutes;
        } else if (endMinutes !== null) {
            isInside = eventMinutes <= endMinutes;
        }

        if (isInside) {
            const startLabel = rule.startTime ?? '--:--';
            const endLabel = rule.endTime ?? '--:--';
            return {
                unavailable: true,
                reason: 'time-slot',
                blockLevel: 'time',
                message: `${officiel.nom} est indisponible le ${dateKey} entre ${startLabel} et ${endLabel}.`,
                rule,
            };
        }
    }

    return { unavailable: false, reason: null, blockLevel: null };
}

export function parseIndispoDateKey(dateKey: string, endOfDay = false): Date | null {
    const match = dateKey.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!match) {
        return null;
    }

    const day = Number.parseInt(match[1] ?? '', 10);
    const month = Number.parseInt(match[2] ?? '', 10);
    const year = Number.parseInt(match[3] ?? '', 10);

    if (!Number.isFinite(day) || !Number.isFinite(month) || !Number.isFinite(year)) {
        return null;
    }

    const date = new Date(year, month - 1, day, 0, 0, 0, 0);
    if (Number.isNaN(date.getTime())) {
        return null;
    }

    if (endOfDay) {
        date.setHours(23, 59, 59, 999);
    }

    return date;
}

export function parseIndispoTimeToMinutes(value?: string): number | null {
    if (!value) {
        return null;
    }

    const match = value.match(/^(\d{1,2}):(\d{2})$/);
    if (!match) {
        return null;
    }

    const hours = Number.parseInt(match[1] ?? '', 10);
    const minutes = Number.parseInt(match[2] ?? '', 10);

    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
        return null;
    }

    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
        return null;
    }

    return hours * 60 + minutes;
}

export type IndispoTemporalStatus = 'future' | 'current' | 'past';

/** Bornes calendaires d'une indisponibilité, via `parseIndispoDateKey`. */
export function getIndispoTimeBounds(rule: OfficielIndisponibilite): { startAt: Date; endAt: Date } | null {
    if (rule.type === 'day-range') {
        const startDateKey = rule.dateStart ?? rule.date;
        const endDateKey = rule.dateEnd ?? rule.dateStart ?? rule.date;
        if (!startDateKey || !endDateKey) {
            return null;
        }

        const startAt = parseIndispoDateKey(startDateKey, false);
        const endAt = parseIndispoDateKey(endDateKey, true);
        if (!startAt || !endAt) {
            return null;
        }
        return { startAt, endAt };
    }

    const dateKey = rule.date ?? rule.dateStart ?? rule.dateEnd;
    if (!dateKey) {
        return null;
    }

    const dayStart = parseIndispoDateKey(dateKey, false);
    if (!dayStart) {
        return null;
    }

    const startMinutes = parseIndispoTimeToMinutes(rule.startTime) ?? 0;
    const endMinutes = parseIndispoTimeToMinutes(rule.endTime) ?? 23 * 60 + 59;

    const startAt = new Date(dayStart);
    startAt.setHours(Math.floor(startMinutes / 60), startMinutes % 60, 0, 0);

    const endAt = new Date(dayStart);
    endAt.setHours(Math.floor(endMinutes / 60), endMinutes % 60, 59, 999);

    return { startAt, endAt };
}

export function getIndispoTemporalStatus(
    rule: OfficielIndisponibilite,
    now: Date = new Date(),
): IndispoTemporalStatus | null {
    const bounds = getIndispoTimeBounds(rule);
    if (!bounds) {
        return null;
    }
    if (now >= bounds.startAt && now <= bounds.endAt) {
        return 'current';
    }
    if (bounds.startAt > now) {
        return 'future';
    }
    return 'past';
}

export interface OfficielIndispoDisplay {
    mode: 'current' | 'next' | null;
    label: string | null;
}

/** Trouve l'indisponibilité en cours (ou la prochaine) pour affichage dans une liste. */
export function getOfficielIndispoDisplay(indisponibilites: OfficielIndisponibilite[] | undefined): OfficielIndispoDisplay {
    const now = new Date();
    const rules = normalizeIndisponibilites(indisponibilites).filter(indispoBlocksPlanning);

    const currentRules: Array<{ rule: OfficielIndisponibilite; endAt: Date }> = [];
    const nextRules: Array<{ rule: OfficielIndisponibilite; startAt: Date }> = [];

    for (const rule of rules) {
        const bounds = getIndispoTimeBounds(rule);
        if (!bounds) {
            continue;
        }

        if (now >= bounds.startAt && now <= bounds.endAt) {
            currentRules.push({ rule, endAt: bounds.endAt });
        } else if (bounds.startAt > now) {
            nextRules.push({ rule, startAt: bounds.startAt });
        }
    }

    if (currentRules.length > 0) {
        currentRules.sort((a, b) => a.endAt.getTime() - b.endAt.getTime());
        const selected = currentRules[0];
        if (!selected) {
            return { mode: null, label: null };
        }
        return {
            mode: 'current',
            label: `Indisponible en cours: ${formatIndisponibiliteLabel(selected.rule)}`,
        };
    }

    if (nextRules.length > 0) {
        nextRules.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
        const selected = nextRules[0];
        if (!selected) {
            return { mode: null, label: null };
        }
        return {
            mode: 'next',
            label: `Prochaine indisponibilité: ${formatIndisponibiliteLabel(selected.rule)}`,
        };
    }

    return { mode: null, label: null };
}
