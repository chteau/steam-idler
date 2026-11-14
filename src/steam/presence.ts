import type { Logger } from '../utils/logger.js';
import type { SteamClientLike } from './client.js';

export interface PresenceOptions {
  appId: number;
  /** How long to wait for Steam to confirm a gamesPlayed call via playingState. */
  confirmTimeoutMs?: number;
  /** Consecutive unconfirmed/reset attempts tolerated before giving up for this logon session. */
  maxUnconfirmedAttempts?: number;
}

export type PresenceStatus = 'offline' | 'idle' | 'pending' | 'playing' | 'blocked' | 'failed';

/**
 * Keeps "playing <appId>" applied while logged on, without spamming Steam:
 * - sends gamesPlayed only when logged on, not blocked, and not already applied/pending;
 * - treats Steam's playingState echo as the confirmation;
 * - never forces (no kickPlayingSession): if a game runs on another session, it waits.
 */
export class PresenceManager {
  private readonly appId: number;
  private readonly confirmTimeoutMs: number;
  private readonly maxUnconfirmed: number;
  private loggedOn = false;
  private blocked = false;
  private status: PresenceStatus = 'offline';
  private unconfirmed = 0;
  private confirmTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly client: SteamClientLike,
    private readonly log: Logger,
    opts: PresenceOptions,
  ) {
    this.appId = opts.appId;
    this.confirmTimeoutMs = opts.confirmTimeoutMs ?? 15_000;
    this.maxUnconfirmed = opts.maxUnconfirmedAttempts ?? 3;
  }

  get state(): PresenceStatus {
    return this.status;
  }

  onLoggedOn(): void {
    if (this.loggedOn) return; // duplicate event for the same session
    this.loggedOn = true;
    this.unconfirmed = 0;
    // A fresh logon session has no game set, whatever we had before.
    this.status = 'idle';
    this.reconcile();
  }

  onDisconnected(): void {
    this.loggedOn = false;
    this.blocked = false;
    this.status = 'offline';
    this.clearConfirmTimer();
  }

  /** steam-user 'playingState' event. */
  onPlayingState(blocked: boolean, playingApp: number): void {
    if (!this.loggedOn) return;
    if (blocked) {
      if (!this.blocked) {
        this.log.warn(
          { playingElsewhere: playingApp },
          'A game is running on another session of this account; waiting for it to stop (not kicking it)',
        );
      }
      this.blocked = true;
      this.status = 'blocked';
      this.clearConfirmTimer();
      return;
    }

    const wasBlocked = this.blocked;
    this.blocked = false;
    if (playingApp === this.appId) {
      this.clearConfirmTimer();
      if (this.status !== 'playing') this.log.info({ appId: this.appId }, 'Steam confirmed: now playing');
      this.status = 'playing';
      this.unconfirmed = 0;
      return;
    }

    // Not blocked and not playing our app: the other session stopped, or our game was cleared.
    if (wasBlocked) {
      this.log.info('Other session stopped playing; restoring presence');
      this.unconfirmed = 0;
    }
    if (this.status === 'playing' || this.status === 'blocked') this.status = 'idle';
    if (this.status === 'pending') {
      // Steam answered our request with something else: count it as an unconfirmed attempt.
      this.clearConfirmTimer();
      this.status = 'idle';
    }
    this.reconcile();
  }

  /** Clears the game on shutdown. Returns true when a gamesPlayed([]) was sent. */
  stop(): boolean {
    this.clearConfirmTimer();
    const wasActive = this.loggedOn && (this.status === 'playing' || this.status === 'pending');
    if (wasActive) this.client.gamesPlayed([]);
    this.status = this.loggedOn ? 'idle' : 'offline';
    this.loggedOn = false;
    return wasActive;
  }

  private reconcile(): void {
    if (!this.loggedOn || this.blocked) return;
    if (this.status !== 'idle') return; // playing, pending, or failed: nothing to send
    if (this.unconfirmed >= this.maxUnconfirmed) {
      this.status = 'failed';
      this.log.error(
        { appId: this.appId, attempts: this.unconfirmed },
        'Steam did not confirm the playing state after several attempts; giving up until the next logon. ' +
          'Check that this account owns the app and STEAM_APP_ID is correct.',
      );
      return;
    }
    this.unconfirmed += 1;
    this.status = 'pending';
    this.log.info({ appId: this.appId, attempt: this.unconfirmed }, 'Setting playing state');
    this.client.gamesPlayed([this.appId]);
    this.confirmTimer = setTimeout(() => {
      this.confirmTimer = undefined;
      if (this.status !== 'pending') return;
      this.log.warn({ appId: this.appId }, 'No playing-state confirmation from Steam yet; retrying');
      this.status = 'idle';
      this.reconcile();
    }, this.confirmTimeoutMs);
    this.confirmTimer.unref();
  }

  private clearConfirmTimer(): void {
    if (this.confirmTimer) clearTimeout(this.confirmTimer);
    this.confirmTimer = undefined;
  }
}
