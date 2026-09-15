'use client';

import { logError } from '@/lib/observability/client-log';
import { useState, memo } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';

interface AddOfficielDialogProps {
  open: boolean;
  onClose: () => void;
  onAdd: (nom: string, telephone: string) => Promise<void>;
}

export const AddOfficielDialog = memo(function AddOfficielDialog({
  open,
  onClose,
  onAdd,
}: AddOfficielDialogProps) {
  const [nom, setNom] = useState('');
  const [telephone, setTelephone] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleAdd = async () => {
    if (!nom.trim()) {
      alert('Le nom est requis');
      return;
    }
    // Le numéro de téléphone est optionnel

    setIsLoading(true);
    try {
      await onAdd(nom.trim(), telephone.trim() || '');
      setNom('');
      setTelephone('');
      onClose();
    } catch (error) {
      logError('app.unhandled', 'Erreur lors de l\'ajout:', error);
      alert('Erreur lors de l\'ajout de l\'officiel');
    } finally {
      setIsLoading(false);
    }
  };

  const handleClose = () => {
    if (!isLoading) {
      setNom('');
      setTelephone('');
      onClose();
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Ajouter un officiel</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="new-officiel-nom">Nom</Label>
            <Input
              id="new-officiel-nom"
              value={nom}
              onChange={(e) => setNom(e.target.value)}
              placeholder="Nom de l'officiel"
              disabled={isLoading}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-officiel-telephone">Numéro de téléphone (optionnel)</Label>
            <Input
              id="new-officiel-telephone"
              type="tel"
              value={telephone}
              onChange={(e) => setTelephone(e.target.value)}
              placeholder="Numéro de téléphone (optionnel)"
              disabled={isLoading}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={isLoading}>
            Annuler
          </Button>
          <Button onClick={handleAdd} disabled={isLoading}>
            {isLoading ? 'Ajout...' : 'Ajouter'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});
