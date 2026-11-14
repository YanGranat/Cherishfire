import { createAudioPlayer, setAudioModeAsync } from "expo-audio";
import type { AudioMode, AudioPlayer } from "expo-audio";
const habitExecutionSound = require("../../assets/sounds/sound_of_executing_a_habit.mp3");
const SOUND_START_OFFSET_SEC = 0.012;
const SOUND_PREROLL_MS = 35;
const SOUND_PREROLL_VOLUME = 0.001;
let executionPlayer: AudioPlayer | null = null;
let executionPlayerInitPromise: Promise<AudioPlayer | null> | null = null;
let executionPlayerPrimed = false;
let audioModePrepared = false;
let audioModePrepareAttempted = false;
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function waitUntilLoaded(
  player: AudioPlayer,
  timeoutMs = 1200,
): Promise<boolean> {
  const startedAt = Date.now();
  while (!player.isLoaded && Date.now() - startedAt < timeoutMs) {
    await sleep(16);
  }
  return player.isLoaded;
}
function disposeExecutionPlayer(): void {
  if (!executionPlayer) return;
  try {
    executionPlayer.remove();
  } catch {
  } finally {
    executionPlayer = null;
    executionPlayerPrimed = false;
  }
}
const AUDIO_MODE_ATTEMPTS: Partial<AudioMode>[] = [
  {
    shouldPlayInBackground: false,
    shouldRouteThroughEarpiece: false,
    allowsBackgroundRecording: false,
    interruptionMode: "mixWithOthers",
  },
  {
    shouldPlayInBackground: false,
    shouldRouteThroughEarpiece: false,
    allowsBackgroundRecording: false,
    interruptionModeAndroid: "mixWithOthers",
  },
];
async function ensureAudioModePrepared(): Promise<void> {
  if (audioModePrepared || audioModePrepareAttempted) return;
  audioModePrepareAttempted = true;
  try {
    for (const modeAttempt of AUDIO_MODE_ATTEMPTS) {
      try {
        await setAudioModeAsync(modeAttempt);
        audioModePrepared = true;
        return;
      } catch {}
    }
  } finally {
    // A native audio-session failure can be transient (for example while
    // Android is changing audio focus). Keep successful preparation cached,
    // but let the next player recreation retry after a failed attempt.
    if (!audioModePrepared) audioModePrepareAttempted = false;
  }
}
async function primePlayer(player: AudioPlayer): Promise<void> {
  if (executionPlayerPrimed) return;
  const previousVolume = player.volume;
  try {
    player.volume = SOUND_PREROLL_VOLUME;
    await player.seekTo(SOUND_START_OFFSET_SEC);
    player.play();
    await sleep(SOUND_PREROLL_MS);
    player.pause();
    await player.seekTo(SOUND_START_OFFSET_SEC);
    executionPlayerPrimed = true;
  } catch {
  } finally {
    player.volume = previousVolume;
  }
}
async function ensureExecutionPlayer(options?: {
  forceRecreate?: boolean;
}): Promise<AudioPlayer | null> {
  if (options?.forceRecreate) {
    disposeExecutionPlayer();
  }
  if (executionPlayer) {
    return executionPlayer;
  }
  if (executionPlayerInitPromise) {
    return executionPlayerInitPromise;
  }
  executionPlayerInitPromise = (async () => {
    let candidate: AudioPlayer | null = null;
    try {
      await ensureAudioModePrepared();
      const player = createAudioPlayer(habitExecutionSound, {
        downloadFirst: true,
        // Sound effect should not keep the global audio session captured.
        keepAudioSessionActive: false,
        updateInterval: 50,
      });
      candidate = player;
      player.loop = false;
      player.volume = 1;
      const loaded = await waitUntilLoaded(player);
      if (loaded) {
        await primePlayer(player);
      }
      // Do not publish the player while the silent preroll is still running.
      // A tap in that window would otherwise play at the preroll volume and
      // then be paused by primePlayer halfway through the user's sound.
      executionPlayer = player;
      candidate = null;
      return player;
    } catch {
      try {
        candidate?.remove();
      } catch {}
      return null;
    } finally {
      executionPlayerInitPromise = null;
    }
  })();
  return executionPlayerInitPromise;
}
export async function warmupHabitExecutionSound(): Promise<void> {
  await ensureExecutionPlayer();
}
export async function playHabitExecutionSound(): Promise<void> {
  let player = executionPlayer ?? (await ensureExecutionPlayer());
  if (!player) {
    return;
  }
  try {
    // Queue seek and play together without an extra sequential native
    // acknowledgement before replaying the sound.
    void player.seekTo(SOUND_START_OFFSET_SEC).catch(() => {});
  } catch {}
  try {
    player.play();
    return;
  } catch {}
  // Last-resort retry with a fresh player instance.
  player = await ensureExecutionPlayer({ forceRecreate: true });
  if (!player) {
    return;
  }
  try {
    void player.seekTo(SOUND_START_OFFSET_SEC).catch(() => {});
  } catch {}
  try {
    player.play();
  } catch {}
}
