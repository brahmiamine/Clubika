'use client';

import { useCallback, useEffect, useState } from 'react';
import { MonitorSmartphone } from 'lucide-react';
import { Button } from '@/app/components/ui/button';
import { apiDelete, apiGet, apiPost } from '@/lib/utils/api';
import { toast } from 'sonner';

export interface ActiveSessionRow {
  id: string;
  current: boolean;
  clientHint: string | null;
  createdOn: string | null;
  lastSeenOn: string | null;
}

interface ActiveSessionsCardProps {
  listUrl: string;
  revokeOthersUrl: string;
  revokeUrl: (id: string) => string;
}

function formatDay(value: string | null): string {
  if (!value) return 'date inconnue';
  const [year, month, day] = value.split('-');
  if (!year || !month || !day) return value;
  return `${day}/${month}/${year}`;
}

export function ActiveSessionsCard({ listUrl, revokeOthersUrl, revokeUrl }: ActiveSessionsCardProps) {
  const [sessions, setSessions] = useState<ActiveSessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | 'others' | null>(null);

  const reload = useCallback(async () => {
    const data = await apiGet<{ sessions: ActiveSessionRow[] }>(listUrl);
    setSessions(data.sessions);
  }, [listUrl]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void reload()
      .catch((error) => {
        if (!cancelled) {
          toast.error(error instanceof Error ? error.message : 'Impossible de charger les sessions');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reload]);

  const revokeOne = async (session: ActiveSessionRow) => {
    setBusyId(session.id);
    try {
      await apiDelete(revokeUrl(session.id));
      toast.success(session.current ? 'Cette session a été révoquée. Reconnectez-vous.' : 'Session révoquée');
      await reload();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Révocation impossible');
    } finally {
      setBusyId(null);
    }
  };

  const revokeOthers = async () => {
    setBusyId('others');
    try {
      await apiPost(revokeOthersUrl);
      toast.success('Les autres sessions ont été révoquées');
      await reload();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Révocation impossible');
    } finally {
      setBusyId(null);
    }
  };

  const others = sessions.filter((session) => !session.current);

  return (
    <div className="space-y-4 rounded-xl border p-4">
      <h3 className="flex items-center gap-2 font-semibold">
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary-soft text-primary">
          <MonitorSmartphone className="h-4 w-4" />
        </span>
        Sessions actives
      </h3>
      <p className="text-xs text-muted-foreground">
        Navigateur approximatif et jour d&apos;activité uniquement. L&apos;adresse IP complète
        et le user-agent brut ne sont pas conservés.
      </p>
      {loading ? (
        <p className="text-sm text-muted-foreground">Chargement des sessions…</p>
      ) : sessions.length === 0 ? (
        <p className="text-sm text-muted-foreground">Aucune session active.</p>
      ) : (
        <ul className="space-y-2">
          {sessions.map((session) => (
            <li
              key={session.id}
              className="flex flex-col gap-2 rounded-lg border bg-card p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {session.clientHint ?? 'Navigateur inconnu'}
                  {session.current ? ' · cet appareil' : ''}
                </p>
                <p className="text-xs text-muted-foreground">
                  Ouverte le {formatDay(session.createdOn)} · dernière activité le {formatDay(session.lastSeenOn)}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busyId !== null}
                onClick={() => void revokeOne(session)}
              >
                {busyId === session.id ? 'Révocation…' : 'Révoquer'}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {others.length > 0 && (
        <Button
          type="button"
          variant="outline"
          disabled={busyId !== null}
          onClick={() => void revokeOthers()}
        >
          {busyId === 'others' ? 'Révocation…' : 'Révoquer les autres sessions'}
        </Button>
      )}
    </div>
  );
}
