'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Plus, Gamepad2, Dumbbell, Trophy, Shield } from 'lucide-react';
import { AddEventDialog, EventType } from './add-event-dialog';

interface AddEventButtonProps {
  onEventAdded: () => void;
}

export function AddEventButton({ onEventAdded }: AddEventButtonProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [eventType, setEventType] = useState<EventType>('amical');

  const handleSelectEventType = (type: EventType) => {
    setEventType(type);
    setDialogOpen(true);
  };

  const handleSuccess = () => {
    onEventAdded();
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="flex items-center gap-2">
            <Plus className="h-4 w-4" />
            <span className="hidden sm:inline">Ajouter</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onClick={() => handleSelectEventType('officiel')}>
            <Shield className="w-4 h-4 mr-2" />
            Match officiel
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => handleSelectEventType('amical')}>
            <Gamepad2 className="w-4 h-4 mr-2" />
            Match amical
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => handleSelectEventType('entrainement')}>
            <Dumbbell className="w-4 h-4 mr-2" />
            Entraînement
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => handleSelectEventType('plateau')}>
            <Trophy className="w-4 h-4 mr-2" />
            Plateau
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AddEventDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        eventType={eventType}
        onSuccess={handleSuccess}
      />
    </>
  );
}
