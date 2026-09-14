'use client';

import { logError } from '@/lib/observability/client-log';
import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPut } from '@/lib/utils/api';
import {
    DEFAULT_APP_SETTINGS,
    normalizeAppSettings,
    pickClubWritableSettings,
    type AppSettings,
} from '@/lib/settings';

const APP_SETTINGS_UPDATED_EVENT = 'app-settings-updated';

/**
 * Recharge les réglages du club (dont les couleurs primaire/secondaire) et les
 * diffuse à toutes les instances de `useAppSettings` — donc à `AppThemeSync`,
 * qui réapplique aussitôt le thème. À appeler juste après une connexion
 * réussie : la navigation SPA de `/login` vers `/club` ou `/mon-planning` ne
 * remonte pas `AppThemeSync`, sinon le thème resterait celui chargé sans
 * session (club par défaut) jusqu'au prochain rechargement complet.
 */
export async function refreshAppSettingsTheme(): Promise<void> {
    if (typeof window === 'undefined') return;
    try {
        const response = await apiGet<AppSettings>('/api/settings');
        const normalized = normalizeAppSettings(response);
        window.dispatchEvent(new CustomEvent<AppSettings>(APP_SETTINGS_UPDATED_EVENT, { detail: normalized }));
    } catch {
        // On garde le thème courant si le rechargement échoue.
    }
}

export function useAppSettings() {
    const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const loadSettings = useCallback(async () => {
        try {
            setIsLoading(true);
            setError(null);
            const response = await apiGet<AppSettings>('/api/settings');
            setSettings(normalizeAppSettings(response));
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : 'Erreur lors du chargement des paramètres';
            setError(errorMessage);
            setSettings(DEFAULT_APP_SETTINGS);
            logError('app.unhandled', 'Error loading app settings:', err);
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        loadSettings();
    }, [loadSettings]);

    useEffect(() => {
        const handleUpdate = (event: Event) => {
            const customEvent = event as CustomEvent<AppSettings>;
            if (!customEvent.detail) {
                return;
            }
            setSettings(normalizeAppSettings(customEvent.detail));
        };

        window.addEventListener(APP_SETTINGS_UPDATED_EVENT, handleUpdate as EventListener);
        return () => {
            window.removeEventListener(APP_SETTINGS_UPDATED_EVENT, handleUpdate as EventListener);
        };
    }, []);

    const saveSettings = useCallback(async (nextSettings: Partial<AppSettings>, smtpPassword?: string) => {
        const normalized = normalizeAppSettings({ ...settings, ...nextSettings });
        const writable = pickClubWritableSettings(normalized);
        const body = smtpPassword
            ? { ...writable, smtp: { ...writable.smtp, password: smtpPassword } }
            : writable;
        const result = await apiPut<{ success: boolean; settings: AppSettings }>('/api/settings', body);
        setSettings(result.settings);
        window.dispatchEvent(new CustomEvent<AppSettings>(APP_SETTINGS_UPDATED_EVENT, { detail: result.settings }));
        return result.settings;
    }, [settings]);

    return {
        settings,
        isLoading,
        error,
        reload: loadSettings,
        saveSettings,
        setSettings,
    };
}
