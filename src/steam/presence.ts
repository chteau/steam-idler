import type { Logger } from '../utils/logger.js';
import type { SteamClientLike } from './client.js';

export interface PresenceOptions {
  appId: number;
  /** How long to wait for Steam to confirm a gamesPlayed call via playingState. */
  confirmTimeoutMs?: number;
  /** Consecutive unconfirmed/reset attempts tolerated before giving up for this logon session. */
  maxUnconfirmedAttempts?: number;
  /**
   * End and restart the play session after this long of continuous play, so Steam records the
   * hours (it credits play time when a session ends). 0 disables.
   */
  sessionCycleMs?: number;
  /** Pause between stopping and restarting the game during a cycle. */
  cycleGapMs?: number;
}

export type PresenceStatus = 'offline' | 'idle' | 'pending' | 'playing' | 'cycling' | 'blocked' | 'failed';

/**
 * Keeps "playing <appId>" applied while logged on, without spamming Steam:
 * - sends gamesPlayed only when logged on, not blocked, and not already applied/pending;
 * - treats Steam's playingState echo as the confirmation;
 * - never forces (no kickPlayingSession): if a game runs on another session, it waits;
 * - optionally restarts the play session every N hours so Steam commits the play time.
 */
export class PresenceManager {
  private readonly appId: number;
  private readonly confirmTimeoutMs: number;
  private readonly maxUnconfirmed: number;
  private readonly sessionCycleMs: number;
  private readonly cycleGapMs: number;
  private loggedOn = false;
  private blocked = false;
  private status: PresenceStatus = 'offline';
  private unconfirmed = 0;
  private confirmTimer: NodeJS.Timeout | undefined;
  private cycleTimer: NodeJS.Timeout | undefined;
  private gapTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly client: SteamClientLike,
    private readonly log: Logger,
    opts: PresenceOptions,
  ) {
    this.appId = opts.appId;
    this.confirmTimeoutMs = opts.confirmTimeoutMs ?? 15_000;
    this.maxUnconfirmed = opts.maxUnconfirmedAttempts ?? 3;
    this.sessionCycleMs = opts.sessionCycleMs ?? 0;
    this.cycleGapMs = opts.cycleGapMs ?? 5_000;
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
    this.clearTimers();
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
      this.clearTimers();
      return;
    }

    const wasBlocked = this.blocked;
    this.blocked = false;

    if (this.status === 'cycling') {
      // Echo of our own gamesPlayed([]); the gap timer restarts the game.
      return;
    }

    if (playingApp === this.appId) {
      this.clearConfirmTimer();
      if (this.status !== 'playing') {
        this.log.info({ appId: this.appId }, 'Steam confirmed: now playing');
        this.status = 'playing';
        this.armCycle();
      }
      this.unconfirmed = 0;
      return;
    }

    // Not blocked and not playing our app: the other session stopped, or our game was cleared.
    if (wasBlocked) {
      this.log.info('Other session stopped playing; restoring presence');
      this.unconfirmed = 0;
    }
    if (this.status === 'pending' && !wasBlocked) {
      // Steam often echoes the previous state (app 0) right after our request; the confirm timer
      // decides whether to retry, so a stale echo can't trigger a duplicate send.
      return;
    }
    if (this.status === 'playing' || this.status === 'blocked' || this.status === 'pending') {
      this.clearConfirmTimer();
      this.clearCycleTimer();
      this.status = 'idle';
    }
    this.reconcile();
  }

  /** Clears the game on shutdown. Returns true when a gamesPlayed([]) was sent. */
  stop(): boolean {
    this.clearTimers();
    const wasActive = this.loggedOn && (this.status === 'playing' || this.status === 'pending');
    if (wasActive) this.client.gamesPlayed([]);
    this.status = this.loggedOn ? 'idle' : 'offline';
    this.loggedOn = false;
    return wasActive;
  }

  private armCycle(): void {
    this.clearCycleTimer();
    if (this.sessionCycleMs <= 0) return;
    this.cycleTimer = setTimeout(() => {
      this.cycleTimer = undefined;
      this.cycle();
    }, this.sessionCycleMs);
    this.cycleTimer.unref();
  }

  /** Ends the current play session (Steam records the hours) and starts a new one shortly after. */
  private cycle(): void {
    // Blocked (you're playing elsewhere), pending or offline: nothing to cycle. When the other
    // game closes, presence is restored, which starts a fresh session anyway.
    if (!this.loggedOn || this.blocked || this.status !== 'playing') return;
    this.log.info(
      { appId: this.appId, afterHours: +(this.sessionCycleMs / 3_600_000).toFixed(2) },
      'Restarting the play session so Steam records the hours',
    );
    this.status = 'cycling';
    this.client.gamesPlayed([]);
    this.gapTimer = setTimeout(() => {
      this.gapTimer = undefined;
      if (this.status !== 'cycling') return; // blocked or disconnected meanwhile
      this.status = 'idle';
      this.unconfirmed = 0;
      this.reconcile();
    }, this.cycleGapMs);
    this.gapTimer.unref();
  }

  private reconcile(): void {
    if (!this.loggedOn || this.blocked) return;
    if (this.status !== 'idle') return; // playing, pending, cycling or failed: nothing to send
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

  private clearCycleTimer(): void {
    if (this.cycleTimer) clearTimeout(this.cycleTimer);
    this.cycleTimer = undefined;
  }

  private clearTimers(): void {
    this.clearConfirmTimer();
    this.clearCycleTimer();
    if (this.gapTimer) clearTimeout(this.gapTimer);
    this.gapTimer = undefined;
  }
}
