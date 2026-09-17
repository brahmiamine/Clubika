// @vitest-environment jsdom
// Issue #10 : l'auteur d'un message peut le supprimer lui-même, sans rôle admin.
// La modération admin existante (issue #259) reste disponible pour les messages
// des autres membres.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatConversation } from './ChatConversation';

type Handler = (...args: unknown[]) => void;
type DeleteAck = (result: { ok: boolean; error?: string; message?: unknown }) => void;

class FakeSocket {
  connected = true;
  private handlers = new Map<string, Handler[]>();
  emitCalls: Array<{ event: string; payload: unknown }> = [];
  /** Simule la vérification serveur : par défaut, refuse (l'appelant écrase ce comportement). */
  deleteAckBehavior: (payload: unknown, acknowledge: DeleteAck) => void = (_payload, acknowledge) =>
    acknowledge({ ok: false, error: 'Suppression réservée à l\'auteur du message ou à un administrateur' });

  on(event: string, handler: Handler) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }

  off() {}

  emit(event: string, payload: unknown, acknowledge?: Handler) {
    this.emitCalls.push({ event, payload });
    if (event === 'chat:resume' && acknowledge) {
      acknowledge({ ok: true, messages: [] });
      return;
    }
    if (event === 'chat:read' && acknowledge) {
      acknowledge({ ok: true });
      return;
    }
    if (event === 'chat:delete' && acknowledge) {
      this.deleteAckBehavior(payload, acknowledge as DeleteAck);
    }
  }

  disconnect() {}
}

const { currentSocketRef, currentUserRef } = vi.hoisted(() => ({
  currentSocketRef: { current: null as FakeSocket | null },
  currentUserRef: { current: { id: 1, nom: 'Moi', clubId: 'afp', accessRole: 'member' } },
}));

function baseMessage(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'm-original',
    roomId: 'room-1',
    senderUserId: 2,
    senderName: 'Alice',
    clientMessageId: 'c-original',
    sequence: 1,
    content: 'On se voit à 18h ?',
    attachment: null,
    replyTo: null,
    forwardedFromName: null,
    createdAt: new Date(2026, 0, 1, 10, 0).toISOString(),
    deletedAt: null,
    reactions: [],
    ...overrides,
  };
}

vi.mock('socket.io-client', () => ({
  io: () => {
    const socket = new (class extends FakeSocket {})();
    currentSocketRef.current = socket;
    return socket;
  },
}));

vi.mock('@/lib/utils/api', () => ({
  apiGet: vi.fn(async (url: string) => {
    if (url.includes('/messages')) {
      return { messages: [currentBaseMessage], peerReadSequence: 0, hasMoreBefore: false };
    }
    return {};
  }),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('@/app/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: currentUserRef.current }),
}));

function stubMatchMedia() {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

Element.prototype.scrollTo = vi.fn();
Element.prototype.scrollIntoView = vi.fn();
if (!('hasPointerCapture' in Element.prototype)) {
  Object.assign(Element.prototype, { hasPointerCapture: () => false, setPointerCapture: () => undefined, releasePointerCapture: () => undefined });
}

// Le mock d'`apiGet` référence `currentBaseMessage`, ré-affecté avant chaque `render`
// pour que le salon renvoie le message adapté au scénario testé.
let currentBaseMessage: ReturnType<typeof baseMessage> = baseMessage();

describe('ChatConversation — suppression d\'un message par son auteur (issue #10)', () => {
  afterEach(() => {
    cleanup();
    currentSocketRef.current = null;
    vi.restoreAllMocks();
  });

  it('shows the delete action on the current user\'s own message and lets a non-admin author delete it', async () => {
    currentUserRef.current = { id: 1, nom: 'Moi', clubId: 'afp', accessRole: 'member' };
    currentBaseMessage = baseMessage({ senderUserId: 1, senderName: 'Moi' });
    stubMatchMedia();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<ChatConversation roomId="room-1" title="Test" />);

    await waitFor(() => expect(currentSocketRef.current).not.toBeNull());
    await screen.findByText('On se voit à 18h ?');

    const deleteButton = screen.getByLabelText('Supprimer mon message');
    currentSocketRef.current!.deleteAckBehavior = (_payload, acknowledge) => {
      acknowledge({ ok: true, message: baseMessage({ senderUserId: 1, senderName: 'Moi', content: '', deletedAt: new Date().toISOString() }) });
    };
    fireEvent.click(deleteButton);

    await waitFor(() => {
      expect(currentSocketRef.current?.emitCalls.some((call) => call.event === 'chat:delete')).toBe(true);
    });
    const deleteCall = currentSocketRef.current!.emitCalls.find((call) => call.event === 'chat:delete')!;
    expect(deleteCall.payload).toEqual({ roomId: 'room-1', messageId: 'm-original' });
    expect(await screen.findByText('Message supprimé')).toBeTruthy();
  });

  it('hides the delete action on another member\'s message for a non-admin who is not the author', async () => {
    currentUserRef.current = { id: 1, nom: 'Moi', clubId: 'afp', accessRole: 'member' };
    currentBaseMessage = baseMessage({ senderUserId: 2, senderName: 'Alice' });
    stubMatchMedia();
    render(<ChatConversation roomId="room-1" title="Test" />);

    await waitFor(() => expect(currentSocketRef.current).not.toBeNull());
    await screen.findByText('On se voit à 18h ?');

    expect(screen.queryByLabelText('Supprimer mon message')).toBeNull();
    expect(screen.queryByLabelText('Supprimer ce message (modération)')).toBeNull();
  });

  it('keeps the admin moderation action available on another member\'s message', async () => {
    currentUserRef.current = { id: 1, nom: 'Admin', clubId: 'afp', accessRole: 'admin' };
    currentBaseMessage = baseMessage({ senderUserId: 2, senderName: 'Alice' });
    stubMatchMedia();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<ChatConversation roomId="room-1" title="Test" />);

    await waitFor(() => expect(currentSocketRef.current).not.toBeNull());
    await screen.findByText('On se voit à 18h ?');

    const moderationButton = screen.getByLabelText('Supprimer ce message (modération)');
    // L'admin ne voit pas le bouton « Supprimer mon message » sur le message d'un autre.
    expect(screen.queryByLabelText('Supprimer mon message')).toBeNull();

    currentSocketRef.current!.deleteAckBehavior = (_payload, acknowledge) => {
      acknowledge({ ok: true, message: baseMessage({ senderUserId: 2, senderName: 'Alice', content: '', deletedAt: new Date().toISOString() }) });
    };
    fireEvent.click(moderationButton);

    await waitFor(() => {
      expect(currentSocketRef.current?.emitCalls.some((call) => call.event === 'chat:delete')).toBe(true);
    });
    expect(await screen.findByText('Message supprimé')).toBeTruthy();
  });

  it('shows an error and does not clear the message when the server rejects the deletion', async () => {
    currentUserRef.current = { id: 1, nom: 'Moi', clubId: 'afp', accessRole: 'member' };
    currentBaseMessage = baseMessage({ senderUserId: 1, senderName: 'Moi' });
    stubMatchMedia();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<ChatConversation roomId="room-1" title="Test" />);

    await waitFor(() => expect(currentSocketRef.current).not.toBeNull());
    await screen.findByText('On se voit à 18h ?');

    // Comportement par défaut du FakeSocket : le serveur refuse la suppression.
    fireEvent.click(screen.getByLabelText('Supprimer mon message'));

    await waitFor(() => {
      expect(currentSocketRef.current?.emitCalls.some((call) => call.event === 'chat:delete')).toBe(true);
    });
    // Le message reste intact : ni purgé ni marqué supprimé côté client.
    expect(screen.getByText('On se voit à 18h ?')).toBeTruthy();
    expect(screen.queryByText('Message supprimé')).toBeNull();
  });
});
