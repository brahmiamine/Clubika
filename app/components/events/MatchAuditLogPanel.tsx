'use client';

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/app/components/ui/accordion';
import { History } from 'lucide-react';
import { useMatchAuditLog } from '@/app/hooks/useMatchAuditLog';
import { LoadingSpinner } from '@/app/components/ui/loading-spinner';

const ACTION_LABELS: Record<string, string> = {
  create: 'Création',
  update: 'Modification',
  delete: 'Suppression',
};

function formatEntryDate(value: string): string {
  try {
    return new Date(value).toLocaleString('fr-FR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return value;
  }
}

export function MatchAuditLogPanel({ matchId }: { matchId: string | undefined | null }) {
  const { entries, isLoading } = useMatchAuditLog(matchId);

  return (
    <Accordion type="single" collapsible className="w-full">
      <AccordionItem value="audit-log">
        <AccordionTrigger className="text-sm">
          <span className="flex items-center gap-2">
            <History className="h-4 w-4" />
            Historique des modifications {entries.length > 0 && `(${entries.length})`}
          </span>
        </AccordionTrigger>
        <AccordionContent>
          {isLoading ? (
            <LoadingSpinner size={20} className="py-4" />
          ) : entries.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">Aucune modification enregistrée</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {entries.map((entry) => (
                <li key={entry.id} className="border-l-2 border-muted pl-3 py-1">
                  <p className="text-foreground">
                    {formatEntryDate(entry.createdAt)} — {ACTION_LABELS[entry.action] || entry.action}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    par {entry.actorLabel}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
