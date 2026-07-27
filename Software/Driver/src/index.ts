/*
 *  Freya System Actuators Driver
 *  The hardware-dependent component of the Freya Vivarium Control System, designed
 *  for use with the Edgeberry hardware (Base Board + Sense'n'Drive hardware cartridge).
 *
 *  Copyright© 2025 Sanne “SpuQ” Santens
 *  Released under the MIT License (see LICENSE.txt)
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
 * OutputChannel — volatile per-channel state plus its single timer handle.
 * ------------------------------------------------------------------------- */
class OutputChannel {
  config: ChannelConfig;
  setpoint: number;
  actual: number;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly channel: number, readonly gpio: number) {
    this.config = { ...DEFAULT_CONFIG };
    this.setpoint = DEFAULT_SETPOINT;
    this.actual = 0;
  }

  /** Cancel and forget this channel's timer, if any. At most one is ever held. */
  clearTimer(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
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

function statesEqual(a: ChannelState, b: ChannelState): boolean {
  return (
    a.channel === b.channel &&
    a.config.mode === b.config.mode &&
    a.config.frequency_hz === b.config.frequency_hz &&
    a.config.rampRate === b.config.rampRate &&
    a.setpoint === b.setpoint &&
    a.actual === b.actual
  );
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
    const candidate = this.buildCandidate(ch, write);
    const changed = await this.applyCandidate(ch, candidate);
    if (changed) this.onChanged(ch.toState());
    return ch.toState();
  }

  async setOutputs(writes: unknown): Promise<ChannelState[]> {
    if (!Array.isArray(writes)) {
      throw new DomainError('EINVAL', 'SetOutputs requires an "outputs" array');
    }
    // Validate every entry first; if any fails, apply none.
    const plans: Array<{ ch: OutputChannel; candidate: ChannelState }> = [];
    for (const write of writes as OutputWrite[]) {
      const ch = this.requireChannel(write?.channel);
      try {
        plans.push({ ch, candidate: this.buildCandidate(ch, write) });
      } catch (err) {
        if (err instanceof DomainError) {
          throw new DomainError(err.code, `channel ${ch.channel}: ${err.message}`);
        }
        throw err;
      }
    }
    // All valid: apply all.
    const results: ChannelState[] = [];
    for (const { ch, candidate } of plans) {
      const changed = await this.applyCandidate(ch, candidate);
      if (changed) this.onChanged(ch.toState());
      results.push(ch.toState());
    }
    return results;
  }

  /** Stop every channel's timer. Part of the shutdown sequence. */
  stopAllTimers(): void {
    for (const ch of this.channels) ch.clearTimer();
  }

  /**
   * Safe-state primitive: attempt to drive every channel low, then report which
   * channels failed rather than discarding outcomes.
   */
  async driveAllLow(): Promise<number[]> {
    const results = await Promise.allSettled(
      this.channels.map((ch) => this.gpio.write(ch.gpio, false)),
    );
    const failed: number[] = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        const ch = this.channels[i];
        ch.config = { ...DEFAULT_CONFIG };
        ch.setpoint = DEFAULT_SETPOINT;
        ch.actual = 0;
      } else {
        failed.push(this.channels[i].channel);
      }
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
   * the resulting candidate. Pure: touches neither the channel nor hardware, so
   * a validation failure leaves everything unchanged (atomicity).
   */
  private buildCandidate(ch: OutputChannel, write: OutputWrite): ChannelState {
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

    return this.validateAndRealize(ch.channel, config, setpoint);
  }

  /**
   * Validate a fully-merged candidate and compute its realized `actual`.
   * Order matters: structural/range checks (EINVAL) run before the Step 1 mode
   * availability gate (EMODE), so an out-of-range frequency on a PWM mode still
   * reports EINVAL. The mode gate lives ONLY here.
   */
  private validateAndRealize(channel: number, config: ChannelConfig, setpoint: number): ChannelState {
    const validModes = ['off', 'switch', 'pwm-slow', 'pwm'];
    if (!validModes.includes(config.mode)) {
      throw new DomainError('EINVAL', `unknown mode ${JSON.stringify(config.mode)}`);
    }

    // frequency_hz is meaningless in off/switch — normalize to null.
    if (config.mode === 'off' || config.mode === 'switch') {
      config.frequency_hz = null;
    }

    if (config.frequency_hz !== null) {
      const f = config.frequency_hz;
      if (typeof f !== 'number' || !Number.isFinite(f)) {
        throw new DomainError('EINVAL', 'frequency_hz must be a finite number');
      }
      if (config.mode === 'pwm-slow' && (f < 0.001 || f > 1)) {
        throw new DomainError('EINVAL', `frequency_hz for pwm-slow must be within 0.001-1 Hz (got ${f})`);
      }
      if (config.mode === 'pwm' && (f < 1 || f > 30)) {
        throw new DomainError('EINVAL', `frequency_hz for pwm must be within 1-30 Hz (got ${f})`);
      }
    }

    if (typeof config.rampRate !== 'number' || !Number.isFinite(config.rampRate) || config.rampRate < 0) {
      throw new DomainError('EINVAL', 'rampRate must be a number >= 0');
    }

    if (typeof setpoint !== 'number' || !Number.isFinite(setpoint) || setpoint < 0 || setpoint > 1) {
      throw new DomainError('EINVAL', `setpoint must be within 0.0-1.0 (got ${JSON.stringify(setpoint)})`);
    }

    // Step 1 mode gate (driver-only). PWM tiers are valid types but not realized yet.
    if (config.mode === 'pwm-slow' || config.mode === 'pwm') {
      throw new DomainError('EMODE', `mode '${config.mode}' is not yet implemented`);
    }

    // No ramping in Step 1: actual equals setpoint, except off which is always 0.
    const actual = config.mode === 'off' ? 0 : setpoint;
    return { channel, config, setpoint, actual };
  }

  private pinHigh(state: ChannelState): boolean {
    // off => low; switch => high when the realized value is >= 0.5.
    return state.config.mode === 'switch' && state.actual >= 0.5;
  }

  /** Apply an already-validated candidate. Returns whether anything changed. */
  private async applyCandidate(ch: OutputChannel, candidate: ChannelState): Promise<boolean> {
    const before = ch.toState();
    if (statesEqual(before, candidate)) return false;

    // Any config change replaces the channel's timer (none exist in Step 1).
    ch.clearTimer();

    const newHigh = this.pinHigh(candidate);
    if (newHigh !== this.pinHigh(before)) {
      try {
        await this.gpio.write(ch.gpio, newHigh);
      } catch (err) {
        throw new DomainError('EIO', `failed to set channel ${ch.channel}: ${(err as Error).message}`);
      }
    }

    ch.config = candidate.config;
    ch.setpoint = candidate.setpoint;
    ch.actual = candidate.actual;
    return true;
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
    const code: SenseNDriveErrorCode = err instanceof DomainError ? err.code : 'EIO';
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
    controller.stopAllTimers();
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