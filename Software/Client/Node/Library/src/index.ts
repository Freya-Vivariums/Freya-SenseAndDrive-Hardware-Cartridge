/*
 * Freya Vivarium Control System - Freya Hardware Cartridge SDK
 * Copyright (C) 2025 Sanne 'SpuQ' Santens
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * @file index.ts
 * @module @freya-vivariums/freya-hardware-cartridge
 * @description
 * Node.js/TypeScript SDK for the freya.cartridge.sensendrive D-Bus service.
 * Provides the SenseNDriveClient class and the shared JSON contract types for
 * connecting to and controlling the Freya Hardware Cartridge digital outputs.
 *
 * @copyright 2025 Sanne "SpuQ" Santens
 * @license MIT
 */

import { EventEmitter } from 'node:events';
import dbus from 'dbus-native';

/* ---------------------------------------------------------------------------
 * D-Bus transport constants (settled contract — do not change)
 * ------------------------------------------------------------------------- */
const DBUS_SERVICE = 'freya.cartridge.sensendrive';
const DBUS_PATH = '/freya/cartridge/sensendrive';
const DBUS_INTERFACE = 'freya.cartridge.sensendrive';
const FREEDESKTOP_SERVICE = 'org.freedesktop.DBus';
const FREEDESKTOP_PATH = '/org/freedesktop/DBus';
const FREEDESKTOP_INTERFACE = 'org.freedesktop.DBus';
const RECONNECT_INTERVAL_MS = 5000;

/* ---------------------------------------------------------------------------
 * Shared JSON contract types.
 *
 * These are the single source of truth for the wire contract of the
 * freya.cartridge.sensendrive service. The driver imports them rather than
 * redeclaring, so all three packages stay in lockstep. All four modes are
 * declared here already; Steps 2-3 (PWM) require no type changes.
 * ------------------------------------------------------------------------- */

export type ChannelMode = 'off' | 'switch' | 'pwm-slow' | 'pwm';

export interface ChannelConfig {
  mode: ChannelMode;
  /** One knob for both PWM tiers: pwm-slow 0.001-1 Hz, pwm 1-30 Hz. `null` in off/switch. */
  frequency_hz: number | null;
  /** Setpoint units per second (>= 0). Stored in Step 1; acted upon later. */
  rampRate: number;
}

export interface ChannelState {
  channel: number;
  config: ChannelConfig;
  setpoint: number;
  actual: number;
}

/** Merge-patch config document: absent key = unchanged, explicit null = reset to default. */
export interface ChannelConfigWrite {
  mode?: ChannelMode;
  frequency_hz?: number | null;
  rampRate?: number | null;
}

/** Merge-patch write document accepted by SetOutput / SetOutputs. */
export interface OutputWrite {
  channel: number;
  config?: ChannelConfigWrite;
  setpoint?: number | null;
}

export type SenseNDriveErrorCode = 'ECHANNEL' | 'EMODE' | 'EINVAL' | 'EIO' | 'EJSON';

/** Typed error carrying the driver's error `code` string. */
export class SenseNDriveError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SenseNDriveError';
    this.code = code;
  }
}

export interface ReadyPayload { schemaVersion: number; }

interface SuccessEnvelope<T> { ok: true; result: T; }
interface ErrorEnvelope { ok: false; error: { code: string; message: string }; }
type ResponseEnvelope<T> = SuccessEnvelope<T> | ErrorEnvelope;

export interface SenseNDriveClientOptions {
  /** Injectable D-Bus connection (defaults to the system bus). Useful for tests. */
  bus?: any;
}

/* ---------------------------------------------------------------------------
 * SenseNDriveClient
 *
 * Thin, typed wrapper around the D-Bus interface. Serializes requests, parses
 * responses, and turns `ok:false` envelopes into thrown SenseNDriveError. The
 * envelope never leaks to callers.
 *
 * Events:
 *   'ready'          (ReadyPayload)   driver available / (re)appeared
 *   'outputChanged'  (ChannelState)   a channel's realized state changed
 *   'disconnected'   ()               driver's bus name was lost
 *
 * The client performs NO mode gating: pwm-slow/pwm pass straight through and
 * the driver rejects them, so this class needs no edits in Steps 2-3.
 * ------------------------------------------------------------------------- */
export class SenseNDriveClient extends EventEmitter {
  private readonly bus: any;
  private iface: any = null;
  private busIface: any = null;
  private connecting = false;
  private disposed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: SenseNDriveClientOptions = {}) {
    super();
    this.bus = options.bus ?? dbus.systemBus();
    void this.watchNameOwner();
    void this.connect();
  }

  private getInterface(service: string, path: string, iface: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const svc = this.bus.getService(service);
      svc.getInterface(path, iface, (err: Error | null, obj: any) => {
        if (err) reject(err);
        else resolve(obj);
      });
    });
  }

  private async connect(): Promise<void> {
    if (this.disposed || this.connecting || this.iface) return;
    this.connecting = true;
    try {
      const iface = await this.getInterface(DBUS_SERVICE, DBUS_PATH, DBUS_INTERFACE);
      this.iface = iface;
      iface.on('Ready', (payload: string) => this.handleReady(payload));
      iface.on('OutputChanged', (payload: string) => this.handleOutputChanged(payload));
      this.emit('ready', { schemaVersion: 1 } as ReadyPayload);
    } catch {
      this.iface = null;
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, RECONNECT_INTERVAL_MS);
  }

  /**
   * Watch org.freedesktop.DBus.NameOwnerChanged for the driver's bus name so a
   * driver restart is detected even if its `Ready` signal is missed.
   */
  private async watchNameOwner(): Promise<void> {
    try {
      const busIface = await this.getInterface(FREEDESKTOP_SERVICE, FREEDESKTOP_PATH, FREEDESKTOP_INTERFACE);
      this.busIface = busIface;
      busIface.on('NameOwnerChanged', (name: string, _oldOwner: string, newOwner: string) => {
        if (name !== DBUS_SERVICE) return;
        if (newOwner && newOwner.length > 0) {
          if (!this.iface) void this.connect();
          else this.emit('ready', { schemaVersion: 1 } as ReadyPayload);
        } else {
          this.iface = null;
          this.emit('disconnected');
        }
      });
    } catch {
      // Best-effort: without the bus daemon interface we still recover via the
      // reconnect timer, we just lose fast restart detection.
    }
  }

  private handleReady(payload: string): void {
    try { this.emit('ready', JSON.parse(payload) as ReadyPayload); }
    catch { this.emit('ready', { schemaVersion: 1 } as ReadyPayload); }
  }

  private handleOutputChanged(payload: string): void {
    try { this.emit('outputChanged', JSON.parse(payload) as ChannelState); }
    catch { /* ignore malformed signal payloads */ }
  }

  private call<T>(method: string, request: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.iface) {
        reject(new SenseNDriveError('EIO', 'not connected to the actuators driver'));
        return;
      }
      let reqJson: string;
      try { reqJson = JSON.stringify(request ?? {}); }
      catch { reject(new SenseNDriveError('EINVAL', 'request is not serializable')); return; }

      this.iface[method](reqJson, (err: Error | null, resJson: string) => {
        if (err) { reject(new SenseNDriveError('EIO', err?.message ?? 'D-Bus call failed')); return; }
        let env: ResponseEnvelope<T>;
        try { env = JSON.parse(resJson); }
        catch { reject(new SenseNDriveError('EIO', 'malformed response envelope from driver')); return; }
        if (!env || typeof env !== 'object' || typeof (env as any).ok !== 'boolean') {
          reject(new SenseNDriveError('EIO', 'invalid response envelope from driver'));
          return;
        }
        if (env.ok) resolve(env.result);
        else reject(new SenseNDriveError(env.error?.code ?? 'EIO', env.error?.message ?? 'unknown driver error'));
      });
    });
  }

  /** Read the state of all six channels. */
  async getOutputs(): Promise<ChannelState[]> {
    const result = await this.call<{ outputs: ChannelState[] }>('GetOutputs', {});
    return result.outputs;
  }

  /** Apply a merge-patch write to a single channel. */
  async setOutput(write: OutputWrite): Promise<ChannelState> {
    return this.call<ChannelState>('SetOutput', write);
  }

  /** Apply a batch of writes atomically (all validate before any apply). */
  async setOutputs(writes: OutputWrite[]): Promise<ChannelState[]> {
    return this.call<ChannelState[]>('SetOutputs', { outputs: writes });
  }

  /** Convenience: drive every channel to setpoint 0 via a single SetOutputs. */
  async setAllOff(): Promise<ChannelState[]> {
    const writes: OutputWrite[] = [];
    for (let channel = 1; channel <= 6; channel++) writes.push({ channel, setpoint: 0 });
    return this.setOutputs(writes);
  }

  /**
   * Re-assert a full desired configuration. This is what consumers should call
   * on `ready`. Calling it spuriously is safe: writes are merge-patch and
   * idempotent, so a write that matches the current state changes nothing and
   * emits no signal.
   */
  async applyDesiredState(writes: OutputWrite[]): Promise<ChannelState[]> {
    return this.setOutputs(writes);
  }

  /** Stop reconnecting and drop all listeners. */
  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.removeAllListeners();
  }
}
