'use client';

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { io, type Socket } from 'socket.io-client';
import { Check, CheckCheck, ChevronDown, ChevronLeft, ChevronRight, Circle, Clock, Download, FileSpreadsheet, FileText, Forward, Mic, Paperclip, Pause, Play, Reply, RotateCw, Send, Smile, Trash2, X } from 'lucide-react';
import { Button } from '@/app/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/app/components/ui/dialog';
import { LoadingSpinner } from '@/app/components/ui/loading-spinner';
import { Popover, PopoverContent, PopoverTrigger } from '@/app/components/ui/popover';
import { useCurrentUser } from '@/app/hooks/useCurrentUser';
import { apiGet } from '@/lib/utils/api';
import { playChatMessageReceivedSound, playChatMessageSentSound, unlockChatSounds } from '@/lib/chat/chatSound';
import { describeMicrophoneError, requestMicrophoneStream } from '@/lib/chat/microphone';
import { setActiveChatRoomId } from '@/lib/notifications/incoming-banner';
import { notifyChatUnreadChanged } from '@/hooks/useUnreadChatCount';
import { CHAT_REACTION_EMOJIS, toggleReactionSummaries, type ChatReactionSummary } from '@/lib/chat/reactions';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

interface ChatAttachment {
  type: 'image' | 'video' | 'audio' | 'gif' | 'document';
  url: string;
  mimeType: string;
  name: string;
  size: number;
}

/** Aperçu d'un message cité par une réponse (issue #268). */
export interface ChatReplyPreview {
  id: string;
  authorName: string;
  snippet: string;
  /** Le message cité n'a pas pu être retrouvé côté serveur. */
  deleted: boolean;
}

/** Conversation cible proposée par le sélecteur de transfert (issue #268). */
interface ChatRoomOption {
  id: string;
  type: 'direct' | 'event' | 'channel';
  name: string;
}

export interface ChatMessage {
  id: string;
  roomId: string;
  senderUserId: number;
  senderName: string;
  clientMessageId: string;
  sequence: number;
  content: string;
  attachment: ChatAttachment | null;
  replyTo: ChatReplyPreview | null;
  forwardedFromName: string | null;
  createdAt: string;
  /** Modération admin (issue #259) : contenu/pièce jointe déjà purgés quand non nul. */
  deletedAt: string | null;
  reactions?: ChatReactionSummary[];
}

interface PendingCommand {
  roomId: string;
  clientMessageId: string;
  content: string;
  attachment: ChatAttachment | null;
  replyTo: ChatReplyPreview | null;
  mentionedUserIds?: number[];
  /** 'sending' : hors ligne ou en attente d'accusé ; 'error' : l'accusé a signalé un échec (retry manuel). */
  status: 'sending' | 'error';
  error?: string;
  /** Horodatage local (jamais transmis au serveur), pour l'affichage groupé par jour. */
  createdAt: string;
}

interface ChatResult<T> {
  ok: boolean;
  error?: string;
  messages?: ChatMessage[];
  message?: T;
  reactions?: ChatReactionSummary[];
}

interface ChatHistoryResponse {
  messages: ChatMessage[];
  peerReadSequence: number;
  hasMoreBefore: boolean;
}

interface ChatConversationProps {
  roomId: string;
  title: string;
  description?: string | null;
  compact?: boolean;
  /** Fourni par la vue mobile : affiche une flèche « retour » (masquée ≥ lg). */
  onBack?: () => void;
  /** Pastille affichée à gauche du titre (logos des clubs pour un événement). */
  avatar?: ReactNode;
  /** Contacts proposés à la frappe de « @ » dans le champ de message. */
  mentionables?: { id: number; nom: string }[];
  /**
   * Vue mobile plein écran : la conversation remplit son conteneur (`h-full`),
   * la zone messages défile seule et le champ de saisie reste fixé en bas.
   * Repasse à la carte dimensionnée à partir de `lg`.
   */
  fill?: boolean;
}

const EMOJIS = [
  '😀', '😂', '😍', '😅', '😊', '🙂', '😉', '😎', '🤔', '😢',
  '😭', '😡', '👍', '👎', '🙏', '👏', '💪', '🔥', '🎉', '❤️',
  '⚽', '🏆', '🟥', '🟨', '⏱️', '📅', '✅', '❌', '👏', '💯',
];

/** Fusionne une page de messages (historique initial, pagination arrière ou réception
 * temps réel) avec le fil déjà affiché : dédoublonnage par `id`, tri stable par `sequence`. */
export function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return Array.from(byId.values()).sort((a, b) => a.sequence - b.sequence);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

// Détecte les liens http(s):// et les domaines en www. dans un message et les
// rend cliquables (nouvel onglet, sans referrer). Le schéma est borné à http/https.
const URL_PATTERN = /(https?:\/\/[^\s<]+[^\s<.,:;!?"')\]}]|www\.[^\s<]+[^\s<.,:;!?"')\]}])/gi;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Met en évidence les `@Nom` correspondant à un contact connu, dans un segment de texte. */
function highlightMentions(text: string, keyPrefix: string, mentionNames: string[]): ReactNode[] {
  if (mentionNames.length === 0) return [text];
  const pattern = new RegExp(
    `@(?:${mentionNames.map(escapeRegExp).sort((a, b) => b.length - a.length).join('|')})`,
    'g',
  );
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null = pattern.exec(text);
  while (match !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    nodes.push(
      <span key={`${keyPrefix}-m-${match.index}`} className="rounded bg-primary/15 px-0.5 font-medium">
        {match[0]}
      </span>,
    );
    lastIndex = match.index + match[0].length;
    match = pattern.exec(text);
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

function linkifyText(text: string, mentionNames: string[] = []): ReactNode[] {
  const withLinks: ReactNode[] = [];
  let lastIndex = 0;
  URL_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null = URL_PATTERN.exec(text);
  while (match !== null) {
    const raw = match[0];
    if (match.index > lastIndex) withLinks.push(text.slice(lastIndex, match.index));
    const href = raw.toLowerCase().startsWith('www.') ? `https://${raw}` : raw;
    withLinks.push(
      <a
        key={`${match.index}-${raw}`}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium underline underline-offset-2 break-all"
      >
        {raw}
      </a>,
    );
    lastIndex = match.index + raw.length;
    match = URL_PATTERN.exec(text);
  }
  if (lastIndex < text.length) withLinks.push(text.slice(lastIndex));

  return withLinks.flatMap((node, index) =>
    typeof node === 'string' ? highlightMentions(node, `s${index}`, mentionNames) : [node],
  );
}

/** Fragment `@requête` juste avant le curseur (début de ligne ou après un espace). */
function mentionQueryAt(value: string, caret: number): { query: string; start: number } | null {
  const before = value.slice(0, caret);
  const match = before.match(/(?:^|\s)@([^\s@]{0,40})$/);
  if (!match) return null;
  return { query: match[1] ?? '', start: caret - (match[1] ?? '').length - 1 };
}

function mentionedIdsFromContent(content: string, mentionables: { id: number; nom: string }[]): number[] {
  const ids: number[] = [];
  for (const person of mentionables) {
    if (!person.nom) continue;
    if (content.includes(`@${person.nom}`) && !ids.includes(person.id)) ids.push(person.id);
  }
  return ids;
}

function dayLabel(date: Date, formatter: Intl.DateTimeFormat): string {
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (sameDay(date, today)) return "Aujourd'hui";
  if (sameDay(date, yesterday)) return 'Hier';
  return formatter.format(date);
}

function formatClock(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '0:00';
  const seconds = Math.round(totalSeconds);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Forme d'onde synthétique déterministe (stable pour une même pièce jointe). */
function waveformBars(seed: string, count = 28): number[] {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const bars: number[] = [];
  for (let i = 0; i < count; i += 1) {
    hash ^= hash << 13;
    hash ^= hash >>> 17;
    hash ^= hash << 5;
    hash >>>= 0;
    const envelope = 0.55 + 0.45 * Math.sin((i / (count - 1)) * Math.PI);
    bars.push(Math.max(0.16, Math.min(1, (0.25 + (hash / 4294967295) * 0.75) * envelope)));
  }
  return bars;
}

/** Lecteur de message vocal type messagerie : bouton lecture + onde animée + durée. */
function VoiceMessage({ url, mine }: { url: string; mine: boolean }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const bars = useMemo(() => waveformBars(url), [url]);

  const syncDuration = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      setDuration(audio.duration);
      return;
    }
    // Blobs WebM de MediaRecorder : durée = Infinity tant qu'on n'a pas cherché la fin.
    const onSeeked = () => {
      audio.removeEventListener('timeupdate', onSeeked);
      audio.currentTime = 0;
      setCurrent(0);
      if (Number.isFinite(audio.duration)) setDuration(audio.duration);
    };
    audio.addEventListener('timeupdate', onSeeked);
    try {
      audio.currentTime = 1e101;
    } catch {
      audio.removeEventListener('timeupdate', onSeeked);
    }
  };

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) void audio.play().catch(() => undefined);
    else audio.pause();
  };

  const progress = duration > 0 ? Math.min(1, current / duration) : 0;
  const seekTo = (clientX: number, element: HTMLElement) => {
    const audio = audioRef.current;
    if (!audio || duration <= 0) return;
    const rect = element.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    audio.currentTime = fraction * duration;
    setCurrent(audio.currentTime);
  };

  return (
    <div
      className={cn(
        'mb-1 flex w-[15rem] max-w-full min-w-0 items-center gap-2 rounded-2xl py-1.5 pl-1.5 pr-2.5',
        mine ? 'bg-primary-foreground/15' : 'bg-background/70',
      )}
    >
      <button
        type="button"
        onClick={toggle}
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
          mine ? 'bg-primary-foreground text-primary' : 'bg-primary text-primary-foreground',
        )}
        aria-label={playing ? 'Mettre en pause' : 'Lire le message vocal'}
      >
        {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 translate-x-[1px]" />}
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div
          className="flex h-7 w-full cursor-pointer items-center gap-[2px] overflow-hidden"
          onClick={(event) => seekTo(event.clientX, event.currentTarget)}
          role="slider"
          aria-label="Progression du message vocal"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
          tabIndex={0}
        >
          {bars.map((height, index) => {
            const barFraction = (index + 0.5) / bars.length;
            const played = barFraction <= progress;
            const active = playing && Math.abs(barFraction - progress) < 1 / bars.length;
            return (
              <span
                key={index}
                className={cn(
                  'min-w-0 flex-1 rounded-full transition-[height] duration-150',
                  mine
                    ? played ? 'bg-primary-foreground' : 'bg-primary-foreground/35'
                    : played ? 'bg-primary' : 'bg-foreground/25',
                  active && 'animate-pulse',
                )}
                style={{ height: `${Math.round(height * 100)}%` }}
              />
            );
          })}
        </div>
        <span className={cn('text-[10px] tabular-nums', mine ? 'text-primary-foreground/75' : 'text-muted-foreground')}>
          {formatClock(playing || current > 0 ? current : duration)}
        </span>
      </div>
      <audio
        ref={audioRef}
        src={url}
        preload="metadata"
        className="hidden"
        onLoadedMetadata={syncDuration}
        onDurationChange={() => {
          const audio = audioRef.current;
          if (audio && Number.isFinite(audio.duration) && audio.duration > 0) setDuration(audio.duration);
        }}
        onTimeUpdate={(event) => setCurrent(event.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setCurrent(0);
          if (audioRef.current) audioRef.current.currentTime = 0;
        }}
      />
    </div>
  );
}

function AttachmentBubble({
  attachment,
  mine,
  onOpenImage,
}: {
  attachment: ChatAttachment;
  mine: boolean;
  onOpenImage?: (url: string) => void;
}) {
  if (attachment.type === 'image' || attachment.type === 'gif') {
    return (
      <button
        type="button"
        onClick={() => onOpenImage?.(attachment.url)}
        className="mb-1 block w-full overflow-hidden rounded-lg"
        aria-label="Agrandir l’image"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={attachment.url} alt={attachment.name || 'Image'} className="max-h-64 w-full object-cover" loading="lazy" />
      </button>
    );
  }
  if (attachment.type === 'video') {
    return <video src={attachment.url} controls preload="metadata" playsInline className="mb-1 max-h-64 w-full rounded-lg bg-black" />;
  }
  if (attachment.type === 'document') {
    const isPdf = attachment.mimeType === 'application/pdf';
    const Icon = isPdf ? FileText : FileSpreadsheet;
    return (
      <a
        href={attachment.url}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(
          'mb-1 flex items-center gap-2.5 rounded-lg p-2.5 transition-colors',
          mine ? 'bg-primary-foreground/10 hover:bg-primary-foreground/15' : 'bg-background/70 hover:bg-background',
        )}
      >
        <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg', mine ? 'bg-primary-foreground/15' : 'bg-primary-soft text-primary')}>
          <Icon className="h-5 w-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{attachment.name || 'Document'}</span>
          <span className={cn('block text-[11px]', mine ? 'text-primary-foreground/70' : 'text-muted-foreground')}>{formatBytes(attachment.size)}</span>
        </span>
        <Download className={cn('h-4 w-4 shrink-0', mine ? 'text-primary-foreground/70' : 'text-muted-foreground')} />
      </a>
    );
  }
  return <VoiceMessage url={attachment.url} mine={mine} />;
}

export function ChatConversation({ roomId, title, description, compact = false, onBack, fill = false, avatar, mentionables = [] }: ChatConversationProps) {
  const { user } = useCurrentUser();
  // Modération admin (issue #259) : suppression d'un message réservée aux administrateurs.
  const canModerate = user?.accessRole === 'admin';
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [content, setContent] = useState('');
  const [pendingAttachment, setPendingAttachment] = useState<ChatAttachment | null>(null);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [pendingList, setPendingList] = useState<PendingCommand[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [peerReadSequence, setPeerReadSequence] = useState(0);
  // Indicateur de frappe (issue #267) : interlocuteurs actuellement en train d'écrire
  // dans ce salon (masqué après ~4 s sans nouveau signal, ou à la réception d'un
  // message). Clé par userId (pas par nom : `nom` n'est pas unique — deux
  // participants peuvent le partager — un tri par nom ferait retirer l'entrée de l'un
  // quand le minuteur de l'autre expire, revue Codex) ; typingTimersRef gère
  // l'expiration individuelle par utilisateur.
  const [typingUsers, setTypingUsers] = useState<Map<number, string>>(() => new Map());
  const typingTimersRef = useRef(new Map<number, number>());
  const lastTypingEmitRef = useRef(0);
  const [hasMoreBefore, setHasMoreBefore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [jumpVisible, setJumpVisible] = useState(false);
  // Réponse/citation en cours de rédaction (issue #268) : bannière au-dessus du champ
  // de saisie, ajoutée au prochain message envoyé.
  const [replyDraft, setReplyDraft] = useState<ChatReplyPreview | null>(null);
  // Message à transférer (issue #268) : ouvre le sélecteur de conversation cible.
  const [forwardMessage, setForwardMessage] = useState<ChatMessage | null>(null);
  const [forwardRooms, setForwardRooms] = useState<ChatRoomOption[] | null>(null);
  const [actionTarget, setActionTarget] = useState<ChatMessage | null>(null);
  const [reactionPickerMessageId, setReactionPickerMessageId] = useState<string | null>(null);
  const longPressRef = useRef<{ timer: number | null; x: number; y: number }>({ timer: null, x: 0, y: 0 });
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  // Barre d'actions repliable (façon Messenger) : visible tant que le champ est
  // vide, repliée derrière un chevron dès qu'on tape pour laisser toute la
  // largeur au texte.
  const [toolsOpen, setToolsOpen] = useState(false);
  const showTools = toolsOpen || content.trim() === '';
  // Appareil tactile : le clavier propose déjà les emojis et la touche « Entrée »
  // doit revenir à la ligne (envoi via le bouton uniquement).
  const [coarsePointer, setCoarsePointer] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [unseenCount, setUnseenCount] = useState(0);
  const messagesRef = useRef<ChatMessage[]>([]);
  const pendingRef = useRef(new Map<string, PendingCommand>());
  const socketRef = useRef<Socket | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  const prevCountRef = useRef(0);
  // Salon actuellement monté : permet à loadOlderMessages d'ignorer une réponse arrivée
  // après que l'utilisateur a changé de conversation (roomId a changé avant la
  // résolution de la requête) — un simple booléen « annulé » ne suffit pas ici, il est
  // réarmé par le nouvel effet dès que le salon change.
  const currentRoomIdRef = useRef(roomId);
  // Vrai le temps d'un rendu après une fusion de page plus ancienne (pagination
  // arrière) : évite que l'effet « nouveaux messages » ne traite ce préfixe comme
  // une arrivée temps réel (auto-scroll bas / badge non-lus).
  const isPrependRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordChunksRef = useRef<BlobPart[]>([]);
  const recordCancelRef = useRef(false);
  const recordTimerRef = useRef<number | null>(null);

  const applyMessages = useCallback((incoming: ChatMessage[]) => {
    setMessages((current) => {
      const merged = mergeMessages(current, incoming);
      messagesRef.current = merged;
      return merged;
    });
  }, []);

  const applyReactions = useCallback((messageId: string, reactions: ChatReactionSummary[]) => {
    setMessages((current) => {
      const merged = current.map((message) => (message.id === messageId ? { ...message, reactions } : message));
      messagesRef.current = merged;
      return merged;
    });
  }, []);

  const syncPendingList = useCallback(() => {
    setPendingList(Array.from(pendingRef.current.values()));
  }, []);

  const removePending = useCallback((clientMessageId: string) => {
    pendingRef.current.delete(clientMessageId);
    syncPendingList();
  }, [syncPendingList]);

  const setPendingStatus = useCallback((clientMessageId: string, patch: Partial<PendingCommand>) => {
    const current = pendingRef.current.get(clientMessageId);
    if (!current) return;
    pendingRef.current.set(clientMessageId, { ...current, ...patch });
    syncPendingList();
  }, [syncPendingList]);

  /** Tente l'envoi d'une commande en attente : hors ligne, elle reste visible en
   * « envoi en cours » (sans erreur) jusqu'à la prochaine reconnexion. */
  const attemptSend = useCallback((command: PendingCommand) => {
    const socket = socketRef.current;
    if (!socket?.connected) return;
    const wireCommand = {
      roomId: command.roomId,
      clientMessageId: command.clientMessageId,
      content: command.content,
      attachment: command.attachment,
      replyToMessageId: command.replyTo?.id ?? null,
      forwardSourceMessageId: null,
      mentionedUserIds: command.mentionedUserIds ?? [],
    };
    socket.emit('chat:send', wireCommand, (result: ChatResult<ChatMessage>) => {
      if (!result.ok || !result.message) {
        setPendingStatus(command.clientMessageId, { status: 'error', error: result.error ?? 'Envoi impossible' });
        return;
      }
      removePending(command.clientMessageId);
      applyMessages([result.message]);
      playChatMessageSentSound();
    });
  }, [applyMessages, removePending, setPendingStatus]);

  const retryPending = useCallback((clientMessageId: string) => {
    const command = pendingRef.current.get(clientMessageId);
    if (!command) return;
    setPendingStatus(clientMessageId, { status: 'sending', error: undefined });
    attemptSend({ ...command, status: 'sending', error: undefined });
  }, [attemptSend, setPendingStatus]);

  // Sons du chat (issue #269) : la lecture audio ne peut démarrer qu'après une première
  // interaction utilisateur (politique autoplay des navigateurs).
  useEffect(() => {
    const unlock = () => unlockChatSounds();
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  useEffect(() => {
    setActiveChatRoomId(roomId);
    return () => setActiveChatRoomId(null);
  }, [roomId]);

  useEffect(() => {
    setReactionPickerMessageId(null);
  }, [roomId]);

  useEffect(() => {
    if (!reactionPickerMessageId) return undefined;
    const closeReactionPicker = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest(`[data-reaction-root="${reactionPickerMessageId}"]`)) return;
      setReactionPickerMessageId(null);
    };
    document.addEventListener('pointerdown', closeReactionPicker);
    return () => document.removeEventListener('pointerdown', closeReactionPicker);
  }, [reactionPickerMessageId]);

  useEffect(() => {
    let cancelled = false;
    currentRoomIdRef.current = roomId;
    // Capturé une fois pour tout l'effet (y compris le nettoyage) : la Map elle-même
    // ne change jamais d'identité, seul son contenu est muté.
    const typingTimers = typingTimersRef.current;
    setLoading(true);
    setError(null);
    setMessages([]);
    messagesRef.current = [];
    pendingRef.current.clear();
    setPendingList([]);
    setPeerReadSequence(0);
    setHasMoreBefore(false);
    // Nouvelle conversation : on repart en bas, sans bouton « aller au dernier ».
    atBottomRef.current = true;
    prevCountRef.current = 0;
    setMention(null);
    setJumpVisible(false);
    setUnseenCount(0);
    // Une citation ou un transfert en préparation référence un message du salon quitté :
    // le garder mènerait `appendMessage` à le rejeter (hors salon) une fois le composeur
    // déjà vidé côté client (issue #268, revue Codex).
    setReplyDraft(null);
    setForwardMessage(null);

    void apiGet<ChatHistoryResponse>(`/api/chat/rooms/${encodeURIComponent(roomId)}/messages`)
      .then((result) => {
        if (cancelled) return;
        applyMessages(result.messages);
        setPeerReadSequence(result.peerReadSequence);
        setHasMoreBefore(result.hasMoreBefore);
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : 'Chargement impossible');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    const socket = io({ path: '/socket.io', withCredentials: true, transports: ['websocket', 'polling'] });
    socketRef.current = socket;

    const resumeFrom = (afterSequence: number) => {
      socket.emit('chat:resume', { roomId, afterSequence }, (result: ChatResult<never>) => {
        if (!result.ok) {
          setError(result.error ?? 'Reconnexion impossible');
          return;
        }
        const resumed = result.messages ?? [];
        applyMessages(resumed);
        const nextSequence = resumed.at(-1)?.sequence ?? afterSequence;
        if (resumed.length === 200 && nextSequence > afterSequence) resumeFrom(nextSequence);
      });
    };

    socket.on('connect', () => {
      setConnected(true);
      const lastSequence = messagesRef.current.at(-1)?.sequence ?? 0;
      resumeFrom(lastSequence);
      // Reconnexion : on retente aussi bien les messages restés hors ligne que ceux
      // dont l'accusé précédent avait échoué (l'utilisateur peut aussi les retenter
      // manuellement sans attendre une reconnexion, voir retryPending).
      for (const command of pendingRef.current.values()) attemptSend(command);
    });
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', (socketError) => setError(socketError.message || 'Connexion temps réel impossible'));
    socket.on('chat:message', (message: ChatMessage) => {
      if (message.roomId !== roomId) return;
      // `chat:message` rediffuse aussi un message existant après modération (suppression) :
      // un id déjà présent est une mise à jour, pas une nouvelle arrivée (pas de son, issue #269).
      const isNewMessage = !messagesRef.current.some((existing) => existing.id === message.id);
      applyMessages([message]);
      // L'écho temps réel du propre message arrive souvent avant l'accusé `chat:send` :
      // retirer le brouillon tout de suite évite deux bulles identiques (pending + confirmé).
      if (message.clientMessageId) removePending(message.clientMessageId);
      if (isNewMessage && message.senderUserId !== user?.id) playChatMessageReceivedSound();
      // Un message vient d'arriver : l'indicateur de frappe n'a plus lieu d'être.
      for (const timer of typingTimers.values()) window.clearTimeout(timer);
      typingTimers.clear();
      setTypingUsers(new Map());
    });
    socket.on('chat:read', (receipt: { roomId: string; userId: number; sequence: number }) => {
      if (receipt.roomId === roomId && receipt.userId !== user?.id) {
        setPeerReadSequence((current) => Math.max(current, receipt.sequence));
      }
    });
    socket.on('chat:typing', (payload: { roomId: string; userId: number; nom: string }) => {
      if (payload.roomId !== roomId || payload.userId === user?.id) return;
      const existingTimer = typingTimers.get(payload.userId);
      if (existingTimer !== undefined) window.clearTimeout(existingTimer);
      setTypingUsers((current) => {
        if (current.get(payload.userId) === payload.nom) return current;
        const next = new Map(current);
        next.set(payload.userId, payload.nom);
        return next;
      });
      const timer = window.setTimeout(() => {
        typingTimers.delete(payload.userId);
        setTypingUsers((current) => {
          if (!current.has(payload.userId)) return current;
          const next = new Map(current);
          next.delete(payload.userId);
          return next;
        });
      }, 4_000);
      typingTimers.set(payload.userId, timer);
    });
    socket.on('chat:reaction', (payload: { roomId: string; messageId: string; reactions: ChatReactionSummary[] }) => {
      if (payload.roomId !== roomId) return;
      applyReactions(payload.messageId, payload.reactions);
    });
    return () => {
      cancelled = true;
      socket.disconnect();
      socketRef.current = null;
      for (const timer of typingTimers.values()) window.clearTimeout(timer);
      typingTimers.clear();
      setTypingUsers(new Map());
    };
  }, [applyMessages, applyReactions, attemptSend, removePending, roomId, user?.id]);

  /** Émission throttlée (max 1/2 s) du signal de frappe tant que le champ n'est pas vide. */
  const notifyTyping = useCallback(() => {
    const socket = socketRef.current;
    if (!socket?.connected) return;
    const now = Date.now();
    if (now - lastTypingEmitRef.current < 2_000) return;
    lastTypingEmitRef.current = now;
    socket.emit('chat:typing', { roomId });
  }, [roomId]);

  const lastSequence = messages.at(-1)?.sequence ?? 0;
  useEffect(() => {
    if (!lastSequence) return;
    const timeout = window.setTimeout(() => {
      const socket = socketRef.current;
      if (socket?.connected) {
        socket.emit('chat:read', { roomId, afterSequence: lastSequence }, () => undefined);
        notifyChatUnreadChanged();
      }
    }, 500);
    return () => window.clearTimeout(timeout);
  }, [lastSequence, roomId]);

  const loadOlderMessages = useCallback(() => {
    if (loadingOlder || !hasMoreBefore) return;
    const oldest = messagesRef.current[0]?.sequence;
    if (!oldest) return;
    setLoadingOlder(true);
    const container = scrollRef.current;
    const previousScrollHeight = container?.scrollHeight ?? 0;
    const previousScrollTop = container?.scrollTop ?? 0;
    const requestedForRoomId = roomId;
    void apiGet<ChatHistoryResponse>(
      `/api/chat/rooms/${encodeURIComponent(roomId)}/messages?beforeSequence=${oldest}`,
    )
      .then((result) => {
        // L'utilisateur a changé de conversation avant la résolution : ignorer, sous
        // peine de mélanger l'historique d'un autre salon dans le fil actuel.
        if (currentRoomIdRef.current !== requestedForRoomId) return;
        isPrependRef.current = true;
        applyMessages(result.messages);
        setHasMoreBefore(result.hasMoreBefore);
        // Fusion en tête de liste : on restaure la position de lecture pour éviter
        // que le fil ne « saute » sous les yeux de l'utilisateur.
        requestAnimationFrame(() => {
          const node = scrollRef.current;
          if (!node) return;
          node.scrollTop = node.scrollHeight - previousScrollHeight + previousScrollTop;
        });
      })
      .catch((loadError) => {
        if (currentRoomIdRef.current !== requestedForRoomId) return;
        setError(loadError instanceof Error ? loadError.message : 'Chargement impossible');
      })
      .finally(() => {
        if (currentRoomIdRef.current !== requestedForRoomId) return;
        setLoadingOlder(false);
      });
  }, [applyMessages, hasMoreBefore, loadingOlder, roomId]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const container = scrollRef.current;
    if (!container) return;
    container.scrollTo({ top: container.scrollHeight, behavior });
    atBottomRef.current = true;
    setJumpVisible(false);
    setUnseenCount(0);
  }, []);

  /** Fait défiler jusqu'au message cité par une réponse (issue #268), si présent
   * dans l'historique chargé. */
  const scrollToMessage = useCallback((messageId: string) => {
    const target = document.getElementById(`chat-message-${messageId}`);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('ring-2', 'ring-primary');
    window.setTimeout(() => target.classList.remove('ring-2', 'ring-primary'), 1_200);
  }, []);

  const handleScroll = () => {
    const container = scrollRef.current;
    if (!container) return;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const atBottom = distanceFromBottom < 80;
    atBottomRef.current = atBottom;
    setJumpVisible(!atBottom);
    if (atBottom) setUnseenCount(0);
    if (container.scrollTop < 120) loadOlderMessages();
  };

  // Ouverture d'une conversation : on colle au dernier message. Plusieurs
  // tentatives (frames + délais) car images, vidéos et messages vocaux changent
  // la hauteur du fil APRÈS leur affichage — sinon le saut tombe trop court.
  useEffect(() => {
    if (loading) return;
    let cancelled = false;
    const stick = () => { if (!cancelled) scrollToBottom('auto'); };
    stick();
    const frame = requestAnimationFrame(() => {
      stick();
      requestAnimationFrame(stick);
    });
    const timers = [120, 400, 900].map((delay) => window.setTimeout(stick, delay));
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      for (const timer of timers) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, roomId]);

  // Média chargé après coup (image, audio, vidéo) : tant que l'utilisateur est
  // en bas du fil, on suit la hauteur qui grandit.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const onMediaReady = (event: Event) => {
      const tag = (event.target as HTMLElement | null)?.tagName;
      if ((tag === 'IMG' || tag === 'VIDEO' || tag === 'AUDIO') && atBottomRef.current) {
        scrollToBottom('auto');
      }
    };
    container.addEventListener('load', onMediaReady, true);
    container.addEventListener('loadedmetadata', onMediaReady, true);
    return () => {
      container.removeEventListener('load', onMediaReady, true);
      container.removeEventListener('loadedmetadata', onMediaReady, true);
    };
  }, [scrollToBottom]);

  // Nouveaux messages : on suit automatiquement si l'utilisateur est déjà en bas
  // (ou vient d'envoyer) ; sinon on incrémente le compteur du bouton « aller au dernier ».
  useEffect(() => {
    const previous = prevCountRef.current;
    prevCountRef.current = messages.length;
    // Un préfixe plus ancien vient d'être fusionné (pagination arrière) : ce n'est pas
    // une arrivée temps réel, ne pas y réagir (ni badge non-lus, ni saut en bas).
    if (isPrependRef.current) {
      isPrependRef.current = false;
      return;
    }
    if (loading || messages.length <= previous) return;
    const lastIsMine = messages.at(-1)?.senderUserId === user?.id;
    if (atBottomRef.current || lastIsMine) {
      scrollToBottom('smooth');
    } else {
      setUnseenCount((count) => count + (messages.length - previous));
      setJumpVisible(true);
    }
  }, [messages, loading, user?.id, scrollToBottom]);

  const timeFormatter = useMemo(() => new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' }), []);
  const dateFormatter = useMemo(() => new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long' }), []);

  const sendCommand = useCallback((command: Omit<PendingCommand, 'status' | 'error' | 'createdAt'>) => {
    const pending: PendingCommand = { ...command, status: 'sending', createdAt: new Date().toISOString() };
    pendingRef.current.set(pending.clientMessageId, pending);
    syncPendingList();
    setError(null);
    attemptSend(pending);
  }, [attemptSend, syncPendingList]);

  const deletePending = useCallback((clientMessageId: string) => {
    removePending(clientMessageId);
  }, [removePending]);

  // Transfert (issue #268) : conversations disponibles, chargées à l'ouverture du
  // sélecteur seulement (pas besoin de les garder à jour en continu).
  useEffect(() => {
    if (!forwardMessage) {
      setForwardRooms(null);
      return;
    }
    let cancelled = false;
    apiGet<{ rooms: ChatRoomOption[] }>('/api/chat/rooms')
      .then((data) => {
        if (cancelled) return;
        setForwardRooms(data.rooms.filter((room) => room.id !== roomId));
      })
      .catch(() => {
        if (!cancelled) setForwardRooms([]);
      });
    return () => { cancelled = true; };
  }, [forwardMessage, roomId]);

  /** Envoie une copie du message vers `targetRoomId`, hors du fil actuellement affiché
   * (le salon cible n'est pas forcément ouvert ici) : émission directe, sans passer par
   * la liste d'attente locale qui n'a de sens que pour la conversation courante. */
  const forwardMessageTo = useCallback((message: ChatMessage, targetRoomId: string) => {
    const socket = socketRef.current;
    if (!socket?.connected) {
      toast.error('Connexion perdue, réessayez dans un instant');
      return;
    }
    const command = {
      roomId: targetRoomId,
      clientMessageId: crypto.randomUUID(),
      content: message.content,
      attachment: message.attachment,
      replyToMessageId: null,
      // Le nom affiché comme « Transféré de … » est dérivé côté serveur à partir de ce
      // message (après vérification d'accès) : le client ne fournit qu'un identifiant.
      forwardSourceMessageId: message.id,
    };
    socket.emit('chat:send', command, (result: ChatResult<ChatMessage>) => {
      if (!result.ok) {
        toast.error(result.error ?? 'Transfert impossible');
        return;
      }
      toast.success('Message transféré');
    });
  }, []);

  /** Modération admin (issue #259) : supprime un message côté serveur (contenu/pièce
   * jointe purgés) ; le message mis à jour revient via chat:message (fusion par id). */
  const deleteMessageOnServer = useCallback((messageId: string) => {
    const socket = socketRef.current;
    if (!socket?.connected) {
      setError('Suppression impossible hors ligne');
      return;
    }
    socket.emit('chat:delete', { roomId, messageId }, (result: ChatResult<ChatMessage>) => {
      if (!result.ok || !result.message) {
        setError(result.error ?? 'Suppression impossible');
        return;
      }
      applyMessages([result.message]);
    });
  }, [applyMessages, roomId]);

  const reactToMessage = useCallback((message: ChatMessage, emoji: string) => {
    if (!user || message.deletedAt) return;
    const socket = socketRef.current;
    if (!socket?.connected) {
      toast.error('Connexion perdue, réessayez dans un instant');
      return;
    }
    setReactionPickerMessageId(null);
    const previous = message.reactions ?? [];
    applyReactions(message.id, toggleReactionSummaries(previous, emoji, user.id));
    socket.emit('chat:react', { roomId, messageId: message.id, emoji }, (result: ChatResult<never>) => {
      if (!result.ok || !result.reactions) {
        applyReactions(message.id, previous);
        toast.error(result.error ?? 'Réaction impossible');
        return;
      }
      applyReactions(message.id, result.reactions);
    });
  }, [applyReactions, roomId, user]);

  const toggleReactionPicker = useCallback((messageId: string) => {
    setReactionPickerMessageId((current) => (current === messageId ? null : messageId));
  }, []);

  const handleMessageCardClick = useCallback((message: ChatMessage, event: MouseEvent<HTMLElement>) => {
    if (coarsePointer || message.deletedAt) return;
    if ((event.target as HTMLElement).closest('a, button, [role="slider"]')) return;
    toggleReactionPicker(message.id);
  }, [coarsePointer, toggleReactionPicker]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const normalized = content.trim();
    if (!normalized && !pendingAttachment) return;
    if (normalized.length > 4_000) return;
    sendCommand({
      roomId,
      clientMessageId: crypto.randomUUID(),
      content: normalized,
      attachment: pendingAttachment,
      replyTo: replyDraft,
      mentionedUserIds: mentionedIdsFromContent(normalized, mentionables),
    });
    setContent('');
    setPendingAttachment(null);
    setReplyDraft(null);
    setMention(null);
    setToolsOpen(false);
  };

  const uploadAttachment = useCallback(async (file: File): Promise<ChatAttachment | null> => {
    setUploading(true);
    setError(null);
    try {
      const body = new FormData();
      body.set('roomId', roomId);
      body.set('file', file);
      const response = await fetch('/api/chat/upload', { method: 'POST', body, credentials: 'include' });
      const data = await response.json() as { attachment?: ChatAttachment; error?: string };
      if (!response.ok || !data.attachment) throw new Error(data.error ?? "Échec de l'envoi du fichier");
      return data.attachment;
    } catch (uploadError) {
      toast.error(uploadError instanceof Error ? uploadError.message : "Échec de l'envoi du fichier");
      return null;
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [roomId]);

  const handleFileSelected = async (file: File | null) => {
    if (!file) return;
    const attachment = await uploadAttachment(file);
    if (attachment) setPendingAttachment(attachment);
  };

  const insertEmoji = (emoji: string) => {
    setContent((current) => `${current}${emoji}`);
    setEmojiOpen(false);
  };

  // Noms affichés dans le bandeau « X écrit… » : dédupliqués pour l'affichage
  // seulement — le suivi individuel par utilisateur (typingUsers) reste par userId.
  const typingNames = useMemo(() => Array.from(new Set(typingUsers.values())), [typingUsers]);

  // --- Mentions « @Nom » --------------------------------------------------------
  const mentionNames = useMemo(
    () => mentionables.map((person) => person.nom).filter((nom): nom is string => Boolean(nom)),
    [mentionables],
  );
  const mentionSuggestions = useMemo(() => {
    if (!mention) return [];
    const needle = mention.query.trim().toLowerCase();
    return mentionables
      .filter((person) => person.nom && (!needle || person.nom.toLowerCase().includes(needle)))
      .slice(0, 6);
  }, [mention, mentionables]);

  const refreshMention = (value: string, caret: number | null) => {
    if (mentionables.length === 0 || caret === null) {
      setMention(null);
      return;
    }
    const found = mentionQueryAt(value, caret);
    setMention(found);
    setMentionIndex(0);
  };

  const insertMention = (person: { nom: string }) => {
    const textarea = textareaRef.current;
    const caret = textarea?.selectionStart ?? content.length;
    const start = mention ? mention.start : caret;
    const next = `${content.slice(0, start)}@${person.nom} ${content.slice(caret)}`;
    setContent(next);
    setMention(null);
    const nextCaret = start + person.nom.length + 2;
    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(nextCaret, nextCaret);
    });
  };

  // --- Message vocal (enregistrement micro) ---------------------------------
  const pickRecorderMime = (): string | undefined => {
    if (typeof MediaRecorder === 'undefined') return undefined;
    for (const type of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']) {
      if (MediaRecorder.isTypeSupported(type)) return type;
    }
    return undefined;
  };

  const stopRecordTimer = () => {
    if (recordTimerRef.current !== null) {
      window.clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
  };

  const startRecording = async () => {
    if (recording || uploading) return;
    if (typeof MediaRecorder === 'undefined') {
      toast.error("L'enregistrement audio n'est pas disponible sur cet appareil");
      return;
    }
    try {
      // getUserMedia déclenche le prompt d’autorisation micro du navigateur.
      const stream = await requestMicrophoneStream();
      const mimeType = pickRecorderMime();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recordChunksRef.current = [];
      recordCancelRef.current = false;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) recordChunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        stopRecordTimer();
        for (const track of stream.getTracks()) track.stop();
        recorderRef.current = null;
        setRecording(false);
        const chunks = recordChunksRef.current;
        recordChunksRef.current = [];
        if (recordCancelRef.current || chunks.length === 0) return;
        const rawType = recorder.mimeType || mimeType || 'audio/webm';
        // MediaRecorder renvoie « audio/webm;codecs=opus » : on garde le type nu,
        // sinon l'API d'upload rejette la pièce jointe (issue message vocal).
        const blobType = rawType.split(';')[0]!.trim() || 'audio/webm';
        const extension = blobType.includes('mp4') ? 'm4a' : blobType.includes('ogg') ? 'ogg' : 'webm';
        const blob = new Blob(chunks, { type: blobType });
        const file = new File([blob], `memo-vocal-${Date.now()}.${extension}`, { type: blobType });
        // Envoi immédiat, comme sur WhatsApp : on relâche → le message vocal part.
        void uploadAttachment(file).then((attachment) => {
          if (attachment) {
            sendCommand({ roomId, clientMessageId: crypto.randomUUID(), content: '', attachment, replyTo: null });
          }
        });
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);
      setRecordSeconds(0);
      recordTimerRef.current = window.setInterval(() => {
        setRecordSeconds((value) => {
          if (value >= 300) {
            recorderRef.current?.stop(); // garde-fou : 5 min maximum
            return value;
          }
          return value + 1;
        });
      }, 1_000);
    } catch (error) {
      toast.error(describeMicrophoneError(error));
    }
  };

  const stopRecording = () => {
    recordCancelRef.current = false;
    recorderRef.current?.stop();
  };

  const cancelRecording = () => {
    recordCancelRef.current = true;
    recorderRef.current?.stop();
  };

  useEffect(() => () => {
    stopRecordTimer();
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recordCancelRef.current = true;
      recorderRef.current.stop();
    }
  }, []);

  useEffect(() => {
    if (!lightboxUrl) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setLightboxUrl(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightboxUrl]);

  useEffect(() => {
    const media = window.matchMedia('(pointer: coarse)');
    const sync = () => setCoarsePointer(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  // Champ de saisie auto-extensible, plafonné à 4 lignes (puis défilement interne).
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    const styles = getComputedStyle(textarea);
    const lineHeight = Number.parseFloat(styles.lineHeight) || 20;
    const verticalPadding = Number.parseFloat(styles.paddingTop) + Number.parseFloat(styles.paddingBottom);
    const verticalBorder = Number.parseFloat(styles.borderTopWidth) + Number.parseFloat(styles.borderBottomWidth);
    const maxHeight = lineHeight * 4 + verticalPadding + verticalBorder;
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
  }, [content]);

  const groups = useMemo(() => {
    const result: Array<{ label: string; items: ChatMessage[] }> = [];
    for (const message of messages) {
      const label = dayLabel(new Date(message.createdAt), dateFormatter);
      const last = result.at(-1);
      if (last && last.label === label) last.items.push(message);
      else result.push({ label, items: [message] });
    }
    return result;
  }, [messages, dateFormatter]);

  const clearLongPress = useCallback(() => {
    if (longPressRef.current.timer !== null) {
      window.clearTimeout(longPressRef.current.timer);
      longPressRef.current.timer = null;
    }
  }, []);

  const beginReply = useCallback((message: ChatMessage) => {
    const mine = message.senderUserId === user?.id;
    setReplyDraft({
      id: message.id,
      authorName: mine ? 'Vous' : message.senderName,
      snippet: message.content || (message.attachment ? 'Pièce jointe' : ''),
      deleted: false,
    });
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [user?.id]);

  const startLongPress = (message: ChatMessage, event: ReactPointerEvent<HTMLElement>) => {
    if (message.deletedAt) return;
    if (event.pointerType === 'mouse') return;
    clearLongPress();
    longPressRef.current.x = event.clientX;
    longPressRef.current.y = event.clientY;
    longPressRef.current.timer = window.setTimeout(() => {
      longPressRef.current.timer = null;
      navigator.vibrate?.(15);
      setActionTarget(message);
    }, 480);
  };

  useEffect(() => () => clearLongPress(), [clearLongPress]);

  const moveLongPress = (event: ReactPointerEvent<HTMLElement>) => {
    if (longPressRef.current.timer === null) return;
    const dx = event.clientX - longPressRef.current.x;
    const dy = event.clientY - longPressRef.current.y;
    if ((dx * dx) + (dy * dy) > 64) clearLongPress();
  };

  return (
    <section
      className={cn(
        'flex min-h-0 flex-col overflow-hidden border bg-card',
        fill
          ? 'h-full rounded-none border-x-0 border-t-0 lg:h-[calc(100dvh-12rem)] lg:min-h-[32rem] lg:rounded-xl lg:border lg:shadow-sm'
          : compact
            ? 'h-[34rem] rounded-xl shadow-sm'
            : 'h-[calc(100dvh-12rem)] min-h-[32rem] rounded-xl shadow-sm',
      )}
      aria-label={`Discussion ${title}`}
    >
      <header className="border-b bg-primary-soft px-2 py-3 sm:px-4">
        <div className="flex items-center gap-2 sm:gap-3">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="-ml-1 shrink-0 rounded-md p-1.5 text-primary hover:bg-secondary-soft lg:hidden"
              aria-label="Retour aux conversations"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
          )}
          {avatar && <span className="shrink-0">{avatar}</span>}
          <div className="min-w-0 flex-1"><h2 className="truncate font-semibold">{title}</h2>{description && <p className="truncate text-xs text-muted-foreground">{description}</p>}</div>
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"><Circle className={cn('h-2.5 w-2.5 fill-current', connected ? 'text-emerald-500 dark:text-emerald-400' : 'text-amber-500 dark:text-amber-400')} />{connected ? 'En ligne' : 'Reconnexion…'}</span>
        </div>
      </header>
      <div className="relative min-h-0 flex-1">
      <div ref={scrollRef} onScroll={handleScroll} className="h-full space-y-1 overflow-y-auto p-4" aria-live="polite">
        {loading ? <LoadingSpinner text="Chargement des messages…" className="py-12" /> : messages.length === 0 && pendingList.length === 0 ? <div className="flex h-full items-center justify-center text-center text-sm text-muted-foreground">Aucun message. Commencez la discussion.</div> : <>
          {loadingOlder && <LoadingSpinner text="Chargement des messages précédents…" className="py-3" />}
          {!loadingOlder && hasMoreBefore && (
            <div className="flex justify-center pb-2">
              <button
                type="button"
                onClick={loadOlderMessages}
                className="rounded-full border bg-card px-3 py-1 text-xs font-medium text-muted-foreground shadow-sm hover:text-foreground"
              >
                Charger les messages précédents
              </button>
            </div>
          )}
          {groups.map((group) => (
          <div key={group.label} className="space-y-3 py-2">
            <div className="sticky top-0 z-10 flex justify-center">
              <span className="rounded-full bg-muted px-3 py-1 text-[11px] font-medium text-muted-foreground shadow-sm">{group.label}</span>
            </div>
            {group.items.map((message) => {
              const mine = message.senderUserId === user?.id;
              const read = mine && message.sequence <= peerReadSequence;
              const deleted = Boolean(message.deletedAt);
              return (
                <article
                  key={message.id}
                  id={`chat-message-${message.id}`}
                  className={cn('group flex items-center gap-1.5 scroll-mt-8 rounded-lg transition-shadow select-none [-webkit-touch-callout:none] lg:select-auto', mine ? 'justify-end' : 'justify-start')}
                  onPointerDown={(event) => startLongPress(message, event)}
                  onPointerUp={clearLongPress}
                  onPointerCancel={clearLongPress}
                  onPointerMove={moveLongPress}
                  onContextMenu={(event) => {
                    if (deleted) return;
                    event.preventDefault();
                    setReactionPickerMessageId(null);
                    setActionTarget(message);
                  }}
                >
                  {canModerate && !deleted && !mine && (
                    <button
                      type="button"
                      onClick={() => {
                        if (window.confirm('Supprimer ce message pour tout le monde ?')) deleteMessageOnServer(message.id);
                      }}
                      className="shrink-0 rounded-md p-1 text-muted-foreground/60 hover:text-destructive"
                      aria-label="Supprimer ce message (modération)"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                  <div className="relative max-w-[85%]" data-reaction-root={message.id}>
                    {!deleted && !coarsePointer && reactionPickerMessageId === message.id && (
                      <div
                        className={cn(
                          'absolute bottom-full z-20 mb-1 flex',
                          mine ? 'right-0' : 'left-0',
                        )}
                      >
                        <div className="flex items-center gap-0.5 rounded-full border border-border bg-background px-1 py-0.5 shadow-md">
                          {CHAT_REACTION_EMOJIS.map((emoji) => (
                            <button
                              key={emoji}
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                reactToMessage(message, emoji);
                              }}
                              className="flex h-7 w-7 items-center justify-center rounded-full text-base hover:bg-muted"
                              aria-label={`Réagir avec ${emoji}`}
                            >
                              {emoji}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    <div
                      className={cn(
                        'rounded-2xl px-3 py-2 text-sm',
                        mine ? 'rounded-br-md bg-primary text-primary-foreground' : 'rounded-bl-md bg-muted',
                        !deleted && !coarsePointer && 'cursor-pointer',
                      )}
                      onClick={(event) => handleMessageCardClick(message, event)}
                    >
                    <p className={cn('mb-0.5 text-[11px] font-medium', mine ? 'text-primary-foreground/75' : 'text-muted-foreground')}>{mine ? 'Vous' : message.senderName}</p>
                    {deleted ? (
                      <p className={cn('italic', mine ? 'text-primary-foreground/70' : 'text-muted-foreground')}>Message supprimé</p>
                    ) : (
                      <>
                        {message.forwardedFromName && (
                          <p className={cn('mb-1 flex items-center gap-1 text-[10px] italic', mine ? 'text-primary-foreground/70' : 'text-muted-foreground')}>
                            <Forward className="h-3 w-3" /> Transféré de {message.forwardedFromName}
                          </p>
                        )}
                        {message.replyTo && (
                          <button
                            type="button"
                            onClick={() => scrollToMessage(message.replyTo!.id)}
                            className={cn(
                              'mb-1.5 block w-full rounded-md border-l-2 px-2 py-1 text-left text-xs',
                              mine ? 'border-primary-foreground/50 bg-primary-foreground/10 hover:bg-primary-foreground/15' : 'border-primary/50 bg-background/70 hover:bg-background',
                            )}
                          >
                            <p className={cn('font-medium', mine ? 'text-primary-foreground/85' : 'text-foreground/85')}>
                              {message.replyTo.deleted ? 'Message' : message.replyTo.authorName}
                            </p>
                            <p className={cn('truncate', mine ? 'text-primary-foreground/70' : 'text-muted-foreground')}>
                              {message.replyTo.deleted ? 'Message indisponible' : message.replyTo.snippet || 'Message'}
                            </p>
                          </button>
                        )}
                        {message.attachment && <AttachmentBubble attachment={message.attachment} mine={mine} onOpenImage={setLightboxUrl} />}
                        {message.content && <p className="whitespace-pre-wrap break-words">{linkifyText(message.content, mentionNames)}</p>}
                      </>
                    )}
                    <div className={cn('mt-1 flex items-center justify-end gap-1 text-[10px]', mine ? 'text-primary-foreground/65' : 'text-muted-foreground')}>
                      <time dateTime={message.createdAt}>{timeFormatter.format(new Date(message.createdAt))}</time>
                      {mine && (read ? <CheckCheck className="h-3.5 w-3.5 text-sky-300" /> : <Check className="h-3.5 w-3.5" />)}
                    </div>
                    </div>
                    {!deleted && (message.reactions ?? []).length > 0 && (
                      <div className={cn('mt-0.5 flex flex-wrap gap-1', mine ? 'justify-end' : 'justify-start')}>
                        {(message.reactions ?? []).map((reaction) => {
                          const mineReaction = user ? reaction.userIds.includes(user.id) : false;
                          return (
                            <button
                              key={reaction.emoji}
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                reactToMessage(message, reaction.emoji);
                              }}
                              className={cn(
                                'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs shadow-sm',
                                mineReaction ? 'border-primary bg-primary/10' : 'border-border bg-card',
                              )}
                              aria-label={`${reaction.emoji}, ${reaction.count} réaction${reaction.count > 1 ? 's' : ''}`}
                              aria-pressed={mineReaction}
                            >
                              <span>{reaction.emoji}</span>
                              <span>{reaction.count}</span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  {!deleted && (
                    <div className={cn('mb-1 hidden shrink-0 items-center gap-0.5 opacity-0 transition-opacity lg:flex lg:focus-within:opacity-100 lg:group-hover:opacity-100', mine && 'order-first')}>
                      <button
                        type="button"
                        onClick={() => beginReply(message)}
                        className="rounded-full p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                        aria-label="Répondre à ce message"
                      >
                        <Reply className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setForwardMessage(message)}
                        className="rounded-full p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                        aria-label="Transférer ce message"
                      >
                        <Forward className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                  {canModerate && !deleted && mine && (
                    <button
                      type="button"
                      onClick={() => {
                        if (window.confirm('Supprimer ce message pour tout le monde ?')) deleteMessageOnServer(message.id);
                      }}
                      className="shrink-0 rounded-md p-1 text-muted-foreground/60 hover:text-destructive"
                      aria-label="Supprimer ce message (modération)"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </article>
              );
            })}
          </div>
          ))}
          {pendingList.length > 0 && (
            <div className="space-y-3 py-2">
              {pendingList.map((pending) => (
                <article key={pending.clientMessageId} className="flex justify-end">
                  <div
                    className={cn(
                      'max-w-[85%] rounded-2xl rounded-br-md px-3 py-2 text-sm',
                      pending.status === 'error' ? 'bg-destructive/10 text-destructive' : 'bg-primary/60 text-primary-foreground',
                    )}
                  >
                    <p className={cn('mb-0.5 text-[11px] font-medium', pending.status === 'error' ? 'text-destructive/75' : 'text-primary-foreground/75')}>Vous</p>
                    {pending.replyTo && (
                      <div className="mb-1.5 rounded-md border-l-2 border-primary-foreground/50 bg-primary-foreground/10 px-2 py-1 text-xs">
                        <p className="font-medium text-primary-foreground/85">{pending.replyTo.authorName}</p>
                        <p className="truncate text-primary-foreground/70">{pending.replyTo.snippet || 'Message'}</p>
                      </div>
                    )}
                    {pending.attachment && <AttachmentBubble attachment={pending.attachment} mine onOpenImage={setLightboxUrl} />}
                    {pending.content && <p className="whitespace-pre-wrap break-words">{linkifyText(pending.content, mentionNames)}</p>}
                    <div className="mt-1 flex items-center justify-end gap-2 text-[10px]">
                      {pending.status === 'sending' ? (
                        <span className="flex items-center gap-1 text-primary-foreground/75">
                          <Clock className="h-3 w-3" /> Envoi en cours…
                        </span>
                      ) : (
                        <span className="flex items-center gap-2">
                          <span>{pending.error ?? 'Échec de l’envoi'}</span>
                          <button
                            type="button"
                            onClick={() => retryPending(pending.clientMessageId)}
                            className="inline-flex items-center gap-1 font-medium underline underline-offset-2"
                          >
                            <RotateCw className="h-3 w-3" /> Réessayer
                          </button>
                          <button
                            type="button"
                            onClick={() => deletePending(pending.clientMessageId)}
                            className="inline-flex items-center gap-1 font-medium underline underline-offset-2"
                          >
                            <Trash2 className="h-3 w-3" /> Supprimer
                          </button>
                        </span>
                      )}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </>}
        <div ref={bottomRef} />
      </div>
      {jumpVisible && (
        <button
          type="button"
          onClick={() => scrollToBottom('smooth')}
          className="absolute bottom-3 right-3 flex h-9 items-center gap-1.5 rounded-full border bg-card px-2 text-muted-foreground shadow-md hover:text-foreground"
          aria-label="Aller au dernier message"
        >
          <ChevronDown className="h-5 w-5" />
          {unseenCount > 0 && (
            <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
              {unseenCount > 99 ? '99+' : unseenCount}
            </span>
          )}
        </button>
      )}
      {typingNames.length > 0 && (
        <div className="absolute bottom-3 left-3 flex items-center gap-1.5 rounded-full border bg-card px-3 py-1.5 text-xs text-muted-foreground shadow-sm" aria-live="polite">
          <span className="flex gap-0.5" aria-hidden="true">
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:-0.3s]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:-0.15s]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/60" />
          </span>
          {typingNames.length === 1 ? `${typingNames[0]} écrit…` : `${typingNames.join(', ')} écrivent…`}
        </div>
      )}
      </div>
      <form onSubmit={submit} className={cn('shrink-0 border-t bg-card p-3', fill && 'pb-[calc(0.75rem_+_env(safe-area-inset-bottom))] lg:pb-3')}>
        {error && <p className="mb-2 text-xs text-destructive" role="alert">{error}</p>}
        {replyDraft && (
          <div className="mb-2 flex items-center gap-2 rounded-lg border-l-2 border-primary bg-muted px-2 py-1.5 text-xs">
            <Reply className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="font-medium text-foreground">{replyDraft.authorName}</p>
              <p className="truncate text-muted-foreground">{replyDraft.snippet || 'Message'}</p>
            </div>
            <button type="button" onClick={() => setReplyDraft(null)} className="text-muted-foreground hover:text-foreground" aria-label="Annuler la réponse"><X className="h-3.5 w-3.5" /></button>
          </div>
        )}
        {pendingAttachment && (
          <div className="mb-2 flex items-center gap-2 rounded-lg border bg-muted px-2 py-1.5 text-xs">
            <span className="truncate">{pendingAttachment.name || pendingAttachment.type} · {formatBytes(pendingAttachment.size)}</span>
            <button type="button" onClick={() => setPendingAttachment(null)} className="ml-auto text-muted-foreground hover:text-foreground" aria-label="Retirer la pièce jointe"><X className="h-3.5 w-3.5" /></button>
          </div>
        )}
        {recording ? (
          <div className="flex items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2">
            <span className="flex h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-destructive" aria-hidden="true" />
            <span className="text-sm font-medium tabular-nums">
              {`${Math.floor(recordSeconds / 60)}:${String(recordSeconds % 60).padStart(2, '0')}`}
            </span>
            <span className="text-xs text-muted-foreground">Enregistrement…</span>
            <div className="ml-auto flex items-center gap-1">
              <Button type="button" variant="ghost" size="icon" onClick={cancelRecording} aria-label="Annuler l’enregistrement">
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
              <Button type="button" size="icon" onClick={stopRecording} aria-label="Envoyer le message vocal">
                <Send className="h-4 w-4" />
              </Button>
            </div>
          </div>
        ) : (
          <div className="relative flex items-end gap-1.5">
            {mention && mentionSuggestions.length > 0 && (
              <ul className="absolute bottom-full left-0 z-20 mb-2 max-h-56 w-[min(18rem,100%)] overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-md">
                {mentionSuggestions.map((person, index) => (
                  <li key={person.id}>
                    <button
                      type="button"
                      onMouseDown={(event) => { event.preventDefault(); insertMention(person); }}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
                        index === mentionIndex ? 'bg-primary-soft text-primary' : 'hover:bg-secondary-soft',
                      )}
                    >
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary-soft text-[11px] font-semibold text-primary">
                        {person.nom.slice(0, 1).toUpperCase()}
                      </span>
                      <span className="truncate">{person.nom}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,video/mp4,video/webm,audio/*,application/pdf,.pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.xlsx,text/csv,.csv"
              className="hidden"
              onChange={(event) => void handleFileSelected(event.target.files?.[0] ?? null)}
            />
            {showTools ? (
              <>
                <Button type="button" variant="ghost" size="icon" disabled={uploading} onClick={() => fileInputRef.current?.click()} aria-label="Joindre un fichier">
                  {uploading ? <LoadingSpinner size={16} /> : <Paperclip className="h-4 w-4" />}
                </Button>
                <Button type="button" variant="ghost" size="icon" disabled={uploading} onClick={() => void startRecording()} aria-label="Enregistrer un message vocal">
                  <Mic className="h-4 w-4" />
                </Button>
              </>
            ) : (
              <Button type="button" variant="ghost" size="icon" onClick={() => setToolsOpen(true)} aria-label="Plus d’actions">
                <ChevronRight className="h-4 w-4" />
              </Button>
            )}
            {!coarsePointer && (
              <Popover open={emojiOpen} onOpenChange={setEmojiOpen}>
                <PopoverTrigger asChild>
                  <Button type="button" variant="ghost" size="icon" aria-label="Insérer un emoji"><Smile className="h-4 w-4" /></Button>
                </PopoverTrigger>
                <PopoverContent className="w-64 p-2" align="start">
                  <div className="grid grid-cols-8 gap-1">
                    {EMOJIS.map((emoji) => (
                      <button key={emoji} type="button" onClick={() => insertEmoji(emoji)} className="rounded p-1 text-lg hover:bg-muted" aria-label={`Insérer ${emoji}`}>{emoji}</button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
            )}
            <textarea
              ref={textareaRef}
              value={content}
              onChange={(event) => {
                setContent(event.target.value);
                if (event.target.value.trim() === '') setToolsOpen(false);
                else notifyTyping();
                refreshMention(event.target.value, event.target.selectionStart);
              }}
              onSelect={(event) => refreshMention(content, event.currentTarget.selectionStart)}
              onBlur={() => window.setTimeout(() => setMention(null), 150)}
              onKeyDown={(event) => {
                if (mention && mentionSuggestions.length > 0) {
                  if (event.key === 'ArrowDown') { event.preventDefault(); setMentionIndex((index) => (index + 1) % mentionSuggestions.length); return; }
                  if (event.key === 'ArrowUp') { event.preventDefault(); setMentionIndex((index) => (index - 1 + mentionSuggestions.length) % mentionSuggestions.length); return; }
                  if (event.key === 'Enter' || event.key === 'Tab') {
                    event.preventDefault();
                    const picked = mentionSuggestions[mentionIndex] ?? mentionSuggestions[0];
                    if (picked) insertMention(picked);
                    return;
                  }
                  if (event.key === 'Escape') { event.preventDefault(); setMention(null); return; }
                }
                // Tactile : « Entrée » = retour à la ligne (envoi via le bouton).
                if (!coarsePointer && event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              maxLength={4_000}
              rows={1}
              className="min-h-10 flex-1 resize-none overflow-y-auto rounded-lg border bg-background px-3 py-2 text-base sm:text-sm"
              placeholder="Écrire un message…"
              aria-label="Message"
            />
            <Button type="submit" size="icon" disabled={!content.trim() && !pendingAttachment} aria-label="Envoyer"><Send className="h-4 w-4" /></Button>
          </div>
        )}
        {!connected && pendingList.length > 0 && <p className="mt-1 text-xs text-muted-foreground">Le message sera envoyé automatiquement après reconnexion.</p>}
      </form>

      {lightboxUrl && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/90 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Image en plein écran"
          onClick={() => setLightboxUrl(null)}
        >
          <button
            type="button"
            onClick={() => setLightboxUrl(null)}
            className="absolute right-3 top-3 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
            aria-label="Fermer"
          >
            <X className="h-5 w-5" />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={lightboxUrl}
            alt=""
            className="max-h-full max-w-full rounded-lg object-contain"
            onClick={(event) => event.stopPropagation()}
          />
        </div>
      )}
      <Dialog open={actionTarget !== null} onOpenChange={(open) => { if (!open) setActionTarget(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Actions du message</DialogTitle>
            <DialogDescription className="line-clamp-2">
              {actionTarget?.content || (actionTarget?.attachment ? 'Pièce jointe' : 'Message')}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <div className="flex justify-between gap-1">
              {CHAT_REACTION_EMOJIS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => {
                    if (!actionTarget) return;
                    reactToMessage(actionTarget, emoji);
                    setActionTarget(null);
                  }}
                  className="flex h-11 w-11 items-center justify-center rounded-full text-xl hover:bg-muted"
                  aria-label={`Réagir avec ${emoji}`}
                >
                  {emoji}
                </button>
              ))}
            </div>
            <Button
              type="button"
              variant="outline"
              className="justify-start"
              onClick={() => {
                if (!actionTarget) return;
                beginReply(actionTarget);
                setActionTarget(null);
              }}
            >
              <Reply className="mr-2 h-4 w-4" /> Répondre
            </Button>
            <Button
              type="button"
              variant="outline"
              className="justify-start"
              onClick={() => {
                if (!actionTarget) return;
                setForwardMessage(actionTarget);
                setActionTarget(null);
              }}
            >
              <Forward className="mr-2 h-4 w-4" /> Transférer
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={forwardMessage !== null} onOpenChange={(open) => { if (!open) setForwardMessage(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Transférer le message</DialogTitle>
            <DialogDescription>Choisissez la conversation de destination.</DialogDescription>
          </DialogHeader>
          <div className="max-h-72 space-y-1 overflow-y-auto">
            {forwardRooms === null ? (
              <LoadingSpinner text="Chargement…" className="py-6" />
            ) : forwardRooms.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">Aucune autre conversation disponible</p>
            ) : (
              forwardRooms.map((room) => (
                <button
                  key={room.id}
                  type="button"
                  onClick={() => {
                    if (forwardMessage) forwardMessageTo(forwardMessage, room.id);
                    setForwardMessage(null);
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted"
                >
                  <span className="truncate">{room.name}</span>
                </button>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
