/*
 *  Freya System Actuators Driver
 *  The hardware-dependent component of the Freya Vivarium Control System, designed
 *  for use with the Edgeberry hardware (Base Board + Sense'n'Drive hardware cartridge).
 *
 *  Copyright© 2025 Sanne “SpuQ” Santens
 *  Released under the GNU General Public License v3.0 (see LICENSE.txt)
 *
 *  SPDX-License-Identifier: GPL-3.0-or-later
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import dbus from 'dbus-native';
import type {
  ChannelConfig,
  ChannelState,
  OutputWrite,
  SenseNDriveErrorCode,
} from '@freya-vivariums/freya-hardware-cartridge';

const execFileAsync = promisify(execFile);

/* ---------------------------------------------------------------------------
 * D-Bus transport constants (settled contract — do not change)
 * ------------------------------------------------------------------------- */
const DBUS_SERVICE = 'freya.cartridge.sensendrive';
const DBUS_PATH = '/freya/cartridge/sensendrive';
const DBUS_INTERFACE = 'freya.cartridge.sensendrive';
const SCHEMA_VERSION = 1;

/*
 * Channel -> GPIO map (Edgeberry Sense'n'Drive Hardware Cartridge).
 * NOTE: these are GPIOxx software numbers, NOT physical header pin positions.
 */
const GPIO_FOR_CHANNEL: readonly number[] = [21, 20, 16, 13, 12, 18];
const CHANNEL_COUNT = GPIO_FOR_CHANNEL.length;

const DEFAULT_CONFIG: ChannelConfig = { mode: 'off', frequency_hz: null, rampRate: 0 };
const DEFAULT_SETPOINT = 0;

/*
 * Valid frequency range for `pulse` mode. The ceiling is bounded by
 * PinctrlGpioPort, which spawns a `pinctrl` process per edge (two edges per
 * cycle). Benchmarked on a Raspberry Pi 5 with Node-RED running, a spawn takes
 * ~1.6 ms (median), ~7 ms (worst), so duty accuracy degrades toward the ceiling
 * as that latency grows relative to the half-period; 60 Hz is the accepted
 * practical maximum. A slower board (or a tighter duty tolerance) warrants a
 * lower ceiling.
 *
 * The frequency cap is not the only limit. Because each edge costs a process
 * spawn, the shortest on-time the engine can resolve is ~5 ms, and that minimum
 * on-time binds before the frequency does at low duty: 60 Hz is fine at 50%
 * duty (~8 ms on-time) but not at 5% (~0.8 ms, below what a per-edge spawn can
 * place). This is documented, not enforced — at extreme duty/frequency pairs
 * the waveform stretches: frequency sags while the duty ratio is roughly
 * preserved. Callers are trusted to stay in sensible operating ranges.
 *
 * The name `pwm` is intentionally left unimplemented and reserved for a future
 * hardware-PWM tier that does not require per-edge process spawns.
 */
const PULSE_MIN_HZ = 0.001;
const PULSE_MAX_HZ = 60;

/* Ramp tick: 2 Hz. Each tick moves `actual` toward `setpoint` by rampRate/2. */
const RAMP_TICK_MS = 500;
const RAMP_TICKS_PER_SECOND = 1000 / RAMP_TICK_MS;

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/* ---------------------------------------------------------------------------
 * Typed domain error. Thrown everywhere internally and converted to the JSON
 * error envelope in exactly one place (the D-Bus method wrapper).
 * ------------------------------------------------------------------------- */
class DomainError extends Error {
  readonly code: SenseNDriveErrorCode;
  constructor(code: SenseNDriveErrorCode, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}

/* ---------------------------------------------------------------------------
 * GpioPort — the single boundary through which ALL hardware access happens.
 * Step 3 replaces the implementation behind this interface; nothing outside it
 * may know how pins are actually driven.
 * ------------------------------------------------------------------------- */
export interface GpioPort {
  /** Mux a GPIO to output and drive it low. Called once per pin at startup. */
  initOutput(gpio: number): Promise<void>;
  /** Change the value of an already-configured output. */
  write(gpio: number, high: boolean): Promise<void>;
}

/** pinctrl-backed GpioPort. Board differences are handled by pinctrl itself. */
class PinctrlGpioPort implements GpioPort {
  async initOutput(gpio: number): Promise<void> {
    await execFileAsync('pinctrl', ['set', String(gpio), 'op', 'dl']);
  }
  async write(gpio: number, high: boolean): Promise<void> {
    await execFileAsync('pinctrl', ['set', String(gpio), high ? 'dh' : 'dl']);
  }
}

/* ---------------------------------------------------------------------------
 * OutputChannel — volatile per-channel state plus its concurrency handles.
 *
 * The pulse engine runs as one `async` loop per channel (`loop`). The ramp
 * tick is a 2 Hz `setInterval` (`rampTimer`). Both are stopped cleanly before
 * any state transition and before shutdown.
 * ------------------------------------------------------------------------- */
class OutputChannel {
  config: ChannelConfig;
  setpoint: number;
  actual: number;
  /** Set false to signal the pulse loop to exit on its next iteration. */
  running = false;
  /** The live pulse loop promise, awaited on stop to guarantee pin quiescence. */
  loop: Promise<void> | null = null;
  /** Resolves the current sleepUntil early; set by the sleep helper, called by stopPulseLoop. */
  wake: (() => void) | null = null;
  rampTimer: ReturnType<typeof setInterval> | null = null;

  constructor(readonly channel: number, readonly gpio: number) {
    this.config = { ...DEFAULT_CONFIG };
    this.setpoint = DEFAULT_SETPOINT;
    this.actual = 0;
  }

  /** Cancel and forget the ramp tick, if any. */
  clearRampTimer(): void {
    if (this.rampTimer) { clearInterval(this.rampTimer); this.rampTimer = null; }
  }

  toState(): ChannelState {
    return {
      channel: this.channel,
      config: { ...this.config },
      setpoint: this.setpoint,
      actual: this.actual,
    };
  }
}

/* ---------------------------------------------------------------------------
 * OutputController — owns the channels and all the API semantics.
 * ------------------------------------------------------------------------- */
class OutputController {
  private readonly channels: OutputChannel[];

  constructor(
    private readonly gpio: GpioPort,
    private readonly onChanged: (state: ChannelState) => void,
  ) {
    this.channels = GPIO_FOR_CHANNEL.map((gpioNum, i) => new OutputChannel(i + 1, gpioNum));
  }

  /** Mux every pin to output and drive it low. Comes up mode "off", setpoint 0. */
  async initialize(): Promise<void> {
    for (const ch of this.channels) {
      await this.gpio.initOutput(ch.gpio);
    }
  }

  getOutputs(): ChannelState[] {
    return this.channels.map((c) => c.toState());
  }

  async setOutput(write: OutputWrite): Promise<ChannelState> {
    const ch = this.requireChannel(write?.channel);
    const plan = this.buildCandidate(ch, write);
    const changed = await this.applyCandidate(ch, plan.config, plan.setpoint);
    if (changed) this.onChanged(ch.toState());
    return ch.toState();
  }

  async setOutputs(writes: unknown): Promise<ChannelState[]> {
    if (!Array.isArray(writes)) {
      throw new DomainError('EINVAL', 'SetOutputs requires an "outputs" array');
    }
    // Validate every entry first; if any fails, apply none.
    const plans: Array<{ ch: OutputChannel; config: ChannelConfig; setpoint: number }> = [];
    for (const write of writes as OutputWrite[]) {
      const ch = this.requireChannel(write?.channel);
      try {
        plans.push({ ch, ...this.buildCandidate(ch, write) });
      } catch (err) {
        if (err instanceof DomainError) {
          throw new DomainError(err.code, `channel ${ch.channel}: ${err.message}`);
        }
        throw err;
      }
    }
    // All valid: apply all.
    const results: ChannelState[] = [];
    for (const { ch, config, setpoint } of plans) {
      const changed = await this.applyCandidate(ch, config, setpoint);
      if (changed) this.onChanged(ch.toState());
      results.push(ch.toState());
    }
    return results;
  }

  /**
   * Stop every pulse loop and ramp tick. Awaits all loop promises so that by
   * the time this resolves, no loop body is executing and no pin write can land
   * after the caller proceeds to driveAllLow().
   */
  async stopAllLoops(): Promise<void> {
    for (const ch of this.channels) ch.clearRampTimer();
    await Promise.all(this.channels.map((ch) => this.stopPulseLoop(ch)));
  }

  /**
   * Drive every channel low. Returns the channels whose write failed. Called
   * only during shutdown, after stopAllLoops() has resolved.
   */
  async driveAllLow(): Promise<number[]> {
    const results = await Promise.allSettled(
      this.channels.map((ch) => this.gpio.write(ch.gpio, false)),
    );
    const failed: number[] = [];
    results.forEach((r, i) => {
      if (r.status === 'rejected') failed.push(this.channels[i].channel);
    });
    return failed;
  }

  private requireChannel(n: unknown): OutputChannel {
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > CHANNEL_COUNT) {
      throw new DomainError(
        'ECHANNEL',
        `channel ${JSON.stringify(n)} does not exist (valid channels are 1-${CHANNEL_COUNT})`,
      );
    }
    return this.channels[n - 1];
  }

  /**
   * Merge-patch the write onto the channel's current state and fully validate
   * the result. Pure: touches neither the channel nor hardware, so a validation
   * failure leaves everything unchanged (atomicity).
   */
  private buildCandidate(ch: OutputChannel, write: OutputWrite): { config: ChannelConfig; setpoint: number } {
    const config: ChannelConfig = { ...ch.config };
    let setpoint = ch.setpoint;

    if (write && typeof write === 'object' && write.config != null) {
      if (typeof write.config !== 'object') {
        throw new DomainError('EINVAL', '"config" must be an object');
      }
      const w = write.config;
      if ('mode' in w) config.mode = w.mode == null ? DEFAULT_CONFIG.mode : (w.mode as ChannelConfig['mode']);
      if ('frequency_hz' in w) config.frequency_hz = w.frequency_hz == null ? DEFAULT_CONFIG.frequency_hz : (w.frequency_hz as number);
      if ('rampRate' in w) config.rampRate = w.rampRate == null ? DEFAULT_CONFIG.rampRate : (w.rampRate as number);
    }
    if (write && typeof write === 'object' && 'setpoint' in write) {
      setpoint = write.setpoint == null ? DEFAULT_SETPOINT : (write.setpoint as number);
    }

    this.validate(config, setpoint);
    return { config, setpoint };
  }

  /**
   * Validate a fully-merged candidate, normalizing `frequency_hz` in place.
   * All checks are EINVAL. `off`/`switch` force `frequency_hz` to null; `pulse`
   * requires it and bounds it to PULSE_MIN_HZ-PULSE_MAX_HZ.
   */
  private validate(config: ChannelConfig, setpoint: number): void {
    const validModes = ['off', 'switch', 'pulse'];
    if (!validModes.includes(config.mode)) {
      throw new DomainError('EINVAL', `unknown mode ${JSON.stringify(config.mode)}`);
    }

    if (typeof config.rampRate !== 'number' || !Number.isFinite(config.rampRate) || config.rampRate < 0) {
      throw new DomainError('EINVAL', 'rampRate must be a number >= 0');
    }
    if (typeof setpoint !== 'number' || !Number.isFinite(setpoint) || setpoint < 0 || setpoint > 1) {
      throw new DomainError('EINVAL', `setpoint must be within 0.0-1.0 (got ${JSON.stringify(setpoint)})`);
    }

    // frequency_hz is meaningless in off/switch — normalize to null.
    if (config.mode === 'off' || config.mode === 'switch') {
      config.frequency_hz = null;
      return;
    }

    // pulse: frequency_hz is required and range-checked.
    const f = config.frequency_hz;
    if (f === null || typeof f !== 'number' || !Number.isFinite(f)) {
      throw new DomainError('EINVAL', `frequency_hz is required for pulse (${PULSE_MIN_HZ}-${PULSE_MAX_HZ} Hz)`);
    }
    if (f < PULSE_MIN_HZ || f > PULSE_MAX_HZ) {
      throw new DomainError('EINVAL', `frequency_hz for pulse must be within ${PULSE_MIN_HZ}-${PULSE_MAX_HZ} Hz (got ${f})`);
    }
  }

  /** The value `actual` is driven toward: 0 in `off`, the setpoint otherwise. */
  private targetOf(config: ChannelConfig, setpoint: number): number {
    return config.mode === 'off' ? 0 : setpoint;
  }

  /**
   * Apply a validated config+setpoint. Computes the new `actual` (respecting
   * ramping), diffs against the current state, and reconciles timers and pins.
   * Returns whether anything changed.
   */
  private async applyCandidate(ch: OutputChannel, config: ChannelConfig, setpoint: number): Promise<boolean> {
    const before = ch.toState();
    const target = this.targetOf(config, setpoint);

    // `actual` is the realized value. Ramping applies in every mode EXCEPT
    // `off`: `off` is a safety state and snaps `actual` to 0 immediately,
    // ignoring rampRate (to fade out, keep the mode and set setpoint 0 — a
    // `setpoint: 0` fades, `mode: 'off'` is a hard stop). Otherwise `actual`
    // jumps to target when there is no ramp, or the ramp tick walks it there.
    let actual: number;
    if (config.mode === 'off') actual = 0;
    else if (config.rampRate <= 0) actual = target;
    else actual = clamp01(ch.actual);

    if (
      before.config.mode === config.mode &&
      before.config.frequency_hz === config.frequency_hz &&
      before.config.rampRate === config.rampRate &&
      before.setpoint === setpoint &&
      before.actual === actual
    ) {
      return false;
    }

    // Only a mode or frequency change restarts the PWM cycle; a setpoint change
    // is picked up at the next cycle start, never mid-cycle.
    const cycleAffecting =
      before.config.mode !== config.mode ||
      before.config.frequency_hz !== config.frequency_hz;

    ch.config = config;
    ch.setpoint = setpoint;
    ch.actual = actual;

    await this.reconcile(ch, cycleAffecting);
    return true;
  }

  /**
   * Bring hardware and timers in line with the channel's current state.
   * `cycleAffecting` true means the pulse loop must be (re)started fresh.
   */
  private async reconcile(ch: OutputChannel, cycleAffecting: boolean): Promise<void> {
    this.updateRampTick(ch);

    switch (ch.config.mode) {
      case 'off':
        await this.stopPulseLoop(ch);
        await this.settle(ch, false);
        break;
      case 'switch':
        await this.stopPulseLoop(ch);
        await this.settle(ch, ch.actual >= 0.5);
        break;
      case 'pulse':
        // Restart on a mode/frequency change; a setpoint/rampRate change lets
        // the running loop pick up the new duty at its next cycle boundary.
        if (cycleAffecting) await this.stopPulseLoop(ch);
        if (!ch.running) {
          ch.running = true;
          ch.loop = this.pulseLoop(ch);
        }
        break;
    }
  }

  /** Signal the pulse loop to stop, wake any in-progress sleep, and await completion. */
  private async stopPulseLoop(ch: OutputChannel): Promise<void> {
    ch.running = false;
    ch.wake?.();
    await (ch.loop ?? Promise.resolve());
    ch.loop = null;
  }

  /**
   * Sleep until an absolute `performance.now()` timestamp, but remain
   * interruptible: `ch.wake` is set to a resolver that cancels the timer early.
   * `stopPulseLoop` calls it after setting `running = false`, so a loop parked
   * in a multi-second (or 16-minute) sleep wakes immediately.
   */
  private sleepUntil(ch: OutputChannel, t: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, Math.max(0, t - performance.now()));
      ch.wake = done;
      function done() { clearTimeout(timer); ch.wake = null; resolve(); }
    });
  }

  /**
   * One async loop per channel in `pulse` mode. Reads duty from `ch.actual` at
   * the top of every cycle so ramp updates are picked up at cycle boundaries.
   * Writes are awaited — the falling edge always happens, just late if the
   * board is slow, so a stuck-high condition is impossible.
   */
  private async pulseLoop(ch: OutputChannel): Promise<void> {
    let cycleStart = performance.now();
    while (ch.running) {
      const period = 1000 / (ch.config.frequency_hz as number);
      const onTime = period * clamp01(ch.actual);

      if (onTime > 0) await this.write(ch, true);
      await this.sleepUntil(ch, cycleStart + onTime);
      if (!ch.running) break;
      if (onTime < period) await this.write(ch, false);
      await this.sleepUntil(ch, cycleStart + period);

      cycleStart += period;
      // Fell behind (slow or contended board): resync instead of chasing the
      // backlog, which would spin the loop with zero-length sleeps.
      if (performance.now() - cycleStart > period) cycleStart = performance.now();
    }
  }

  /** Awaited pin write for the steady (off/switch) modes — logs on failure, never throws. */
  private async settle(ch: OutputChannel, high: boolean): Promise<void> {
    try {
      await this.gpio.write(ch.gpio, high);
    } catch (err) {
      console.error(`channel ${ch.channel} pin write failed: ${(err as Error).message}`);
    }
  }

  /** Awaited pin write for the pulse loop — logs on failure, never throws. */
  private async write(ch: OutputChannel, high: boolean): Promise<void> {
    try {
      await this.gpio.write(ch.gpio, high);
    } catch (err) {
      console.error(`channel ${ch.channel} pin write failed: ${(err as Error).message}`);
    }
  }

  /**
   * Start or stop the 2 Hz ramp tick to match the channel's state. A channel at
   * rest (rampRate 0, or actual already at target) runs no tick.
   */
  private updateRampTick(ch: OutputChannel): void {
    const target = this.targetOf(ch.config, ch.setpoint);
    if (ch.config.rampRate <= 0 || ch.actual === target) {
      ch.clearRampTimer();
      return;
    }
    if (ch.rampTimer !== null) return;
    ch.rampTimer = setInterval(() => { void this.rampTick(ch); }, RAMP_TICK_MS);
  }

  /**
   * One 2 Hz ramp step: move `actual` toward the target by rampRate/2, clamping
   * so it lands exactly on target and then stops. Emits OutputChanged every
   * tick — that IS the intended ~2 Hz emission rate during a ramp.
   */
  private async rampTick(ch: OutputChannel): Promise<void> {
    const target = this.targetOf(ch.config, ch.setpoint);
    const step = ch.config.rampRate / RAMP_TICKS_PER_SECOND;
    ch.actual = ch.actual < target
      ? Math.min(target, ch.actual + step)
      : Math.max(target, ch.actual - step);

    if (ch.actual === target) ch.clearRampTimer();

    // Reflect the new `actual` on the hardware.
    if (ch.config.mode === 'switch') {
      // Use the awaited settle() path so the final tick's threshold edge is
      // always applied even though the ramp timer has just been cancelled.
      await this.settle(ch, ch.actual >= 0.5);
    }
    // pulse: the loop picks up the new `actual` at its next cycle boundary.

    this.onChanged(ch.toState());
  }
}

/* ---------------------------------------------------------------------------
 * D-Bus wiring.
 * ------------------------------------------------------------------------- */
const systemBus = dbus.systemBus();

/**
 * The exported D-Bus service object. `emit` is monkey-patched by
 * exportInterface() to actually dispatch signals onto the bus.
 */
const serviceObject: {
  GetOutputs: (request: string) => Promise<string>;
  SetOutput: (request: string) => Promise<string>;
  SetOutputs: (request: string) => Promise<string>;
  emit: (signalName: string, ...args: any[]) => void;
} = {
  GetOutputs: (request) => handle(request, async () => ({ outputs: controller.getOutputs() })),
  SetOutput: (request) => handle(request, (req) => controller.setOutput(req as OutputWrite)),
  SetOutputs: (request) => handle(request, (req) => controller.setOutputs((req as { outputs?: unknown })?.outputs)),
  emit: () => { /* replaced by exportInterface() */ },
};

const controller = new OutputController(new PinctrlGpioPort(), (state) => {
  serviceObject.emit('OutputChanged', JSON.stringify(state));
});

/**
 * The one and only place domain errors become the JSON error envelope. Parses
 * the bare request document, runs the handler, and envelopes the result.
 */
async function handle(requestJson: string, fn: (req: any) => Promise<unknown>): Promise<string> {
  try {
    let req: unknown;
    try {
      req = requestJson && requestJson.length ? JSON.parse(requestJson) : {};
    } catch {
      throw new DomainError('EJSON', 'request body is not valid JSON');
    }
    const result = await fn(req);
    return JSON.stringify({ ok: true, result });
  } catch (err) {
    // A DomainError carries an intentional code. Anything else is an unexpected
    // bug (e.g. a TypeError) and must NOT masquerade as EIO, which the client
    // treats as a genuine hardware pin fault — surface those as EINTERNAL.
    const code: SenseNDriveErrorCode = err instanceof DomainError ? err.code : 'EINTERNAL';
    const message = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ ok: false, error: { code, message } });
  }
}

function registerDbusName(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!systemBus) {
      reject(new Error('no system bus available'));
      return;
    }
    systemBus.requestName(DBUS_SERVICE, 0, (err: Error | null, res: number) => {
      if (err) {
        reject(new Error(`D-Bus name acquisition failed: ${err.message ?? err}`));
        return;
      }
      if (res !== 1) {
        reject(new Error(`unexpected reply while requesting D-Bus name: ${res}`));
        return;
      }
      resolve();
    });
  });
}

function releaseDbusName(): Promise<void> {
  return new Promise((resolve) => {
    if (!systemBus) { resolve(); return; }
    systemBus.releaseName(DBUS_SERVICE, (err: Error | null) => {
      if (err) console.warn(`Failed to release D-Bus name: ${err.message ?? err}`);
      resolve();
    });
  });
}

function createDbusInterface(): void {
  systemBus.exportInterface(serviceObject, DBUS_PATH, {
    name: DBUS_INTERFACE,
    methods: {
      GetOutputs: ['s', 's'],
      SetOutput: ['s', 's'],
      SetOutputs: ['s', 's'],
    },
    signals: {
      Ready: ['s'],
      OutputChanged: ['s'],
    },
  });
}

/* ---------------------------------------------------------------------------
 * Lifecycle.
 * ------------------------------------------------------------------------- */
async function main(): Promise<void> {
  if (!systemBus) throw new Error('D-Bus client could not connect to the system bus');
  // Startup order: mux pins -> drive all low -> acquire name -> export -> Ready.
  await controller.initialize();
  await registerDbusName();
  createDbusInterface();
  serviceObject.emit('Ready', JSON.stringify({ schemaVersion: SCHEMA_VERSION }));
  console.log(`freya.cartridge.sensendrive ready (schemaVersion ${SCHEMA_VERSION})`);
}

let shuttingDown = false;

/**
 * Fully-awaited shutdown, guarded against double invocation: stop all timers ->
 * drive all outputs low -> release the D-Bus name -> exit.
 */
async function shutdown(code: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await controller.stopAllLoops();
    const failed = await controller.driveAllLow();
    if (failed.length) {
      console.error(`Failed to drive channels low on shutdown: ${failed.join(', ')}`);
    }
    await releaseDbusName();
  } catch (err) {
    console.error('Error during shutdown:', err);
  } finally {
    process.exit(code);
  }
}

process.on('SIGTERM', () => { void shutdown(0); });
process.on('SIGINT', () => { void shutdown(0); });
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  void shutdown(1);
});

main().catch((err) => {
  console.error('Startup failed:', err);
  void shutdown(1);
});