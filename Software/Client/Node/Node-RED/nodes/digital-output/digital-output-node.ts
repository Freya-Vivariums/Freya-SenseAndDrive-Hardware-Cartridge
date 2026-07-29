/*
 * Freya Vivarium Control System - Digital Output Node
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
 * @file digital-output-node.ts
 * @module digital-output-node
 * @description
 * Node-RED node that uses the `@freya-vivariums/freya-hardware-cartridge` library
 * to communicate with Freya's System Actuators Driver over D-Bus.
 *
 * @copyright 2025 Sanne "SpuQ" Santens
 * @license MIT
 */

import { NodeAPI, NodeInitializer, Node, NodeMessageInFlow, NodeDef } from 'node-red';
import {
  SenseNDriveClient,
  SenseNDriveError,
  SenseNDriveConnectionError,
  OutputWrite,
  ChannelState,
  ChannelMode,
} from '@freya-vivariums/freya-hardware-cartridge';

interface NodeConfig extends NodeDef {
  name: string;
  channel: string;
  mode: string;
  frequency_hz: string;
  rampRate: string;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Render a 0.0-1.0 float as a whole-percent string (no float noise). */
function formatPercent(n: number): string {
  return `${Math.round(clamp01(n) * 100)}%`;
}

/*
 * Every Digital Output node talks to the same system-bus service, so they all
 * share one connection. Rather than a configuration node, a single lazily
 * created client is shared across every node instance for the lifetime of the
 * Node-RED process. Listeners are ref'd/unref'd per node in create/close, and
 * the listener cap is lifted because 6 channels x 3 events exceeds the default.
 */
let sharedClient: SenseNDriveClient | null = null;
function getSharedClient(): SenseNDriveClient {
  if (!sharedClient) {
    sharedClient = new SenseNDriveClient();
    sharedClient.setMaxListeners(0);
  }
  return sharedClient;
}

const digitalOutput: NodeInitializer = (RED: NodeAPI) => {
  function DigitalOutputNode(this: Node, config: NodeConfig) {
    RED.nodes.createNode(this, config);
    const node = this;

    const channel = parseInt(config.channel, 10);
    if (!Number.isInteger(channel) || channel < 1 || channel > 6) {
      // No channel assigned: the node is disabled (not an error).
      node.status({ fill: 'grey', shape: 'ring', text: 'disabled' });
      return;
    }
    const client = getSharedClient();

    // All three modes (off, switch, pulse) are selectable; the value passes
    // straight to the driver, which realizes it.
    const configuredMode = (config.mode || 'switch') as ChannelMode;
    const rampRate = parseFloat(config.rampRate);
    const frequency = parseFloat(config.frequency_hz);
    let lastSetpoint = 0;

    const desiredState = (): OutputWrite => ({
      channel,
      config: {
        mode: configuredMode,
        rampRate: Number.isFinite(rampRate) ? rampRate : 0,
        frequency_hz: Number.isFinite(frequency) ? frequency : null,
      },
      setpoint: lastSetpoint,
    });

    // Status mirrors the driver's own rules: in `switch` the pin is ON only at
    // actual >= 0.5 (matching the driver, not the old actual > 0 test); the PWM
    // tiers are proportional, so show the duty as a percentage.
    const showState = (state: ChannelState): void => {
      const mode = state.config.mode;
      if (mode === 'switch') {
        if (state.actual >= 0.5) node.status({ fill: 'green', shape: 'dot', text: 'ON' });
        else node.status({ fill: 'grey', shape: 'ring', text: 'OFF' });
      } else if (mode === 'pulse') {
        if (state.actual > 0) node.status({ fill: 'green', shape: 'dot', text: `Pulse ${formatPercent(state.actual)}` });
        else node.status({ fill: 'grey', shape: 'ring', text: 'Pulse 0%' });
      } else {
        node.status({ fill: 'grey', shape: 'ring', text: 'OFF' });
      }
    };

    const showError = (err: unknown): void => {
      const code = err instanceof SenseNDriveError ? err.code : 'EIO';
      node.status({ fill: 'red', shape: 'dot', text: code });
    };

    // Re-assert our configured state. Called on the library's 'ready' event
    // (driver connect/reconnect) and once at setup, so a node created against an
    // already-connected shared client (e.g. on flow redeploy) still reconciles.
    const reconcile = (): void => {
      client.applyDesiredState([desiredState()])
        .then((states) => {
          const s = states.find((x) => x.channel === channel);
          if (s) showState(s);
        })
        .catch((err) => {
          // A connection error just means the driver isn't reachable yet; 'ready'
          // will reconcile later. A real EIO (pin-write fault) is NOT swallowed.
          if (!(err instanceof SenseNDriveConnectionError)) showError(err);
        });
    };
    const onReady = (): void => reconcile();
    const onDisconnected = (): void => {
      node.status({ fill: 'blue', shape: 'ring', text: 'driver offline' });
    };
    const onOutputChanged = (state: ChannelState): void => {
      if (state.channel !== channel) return;
      lastSetpoint = state.setpoint;
      showState(state);
      node.send({ payload: state });
    };

    client.on('ready', onReady);
    client.on('disconnected', onDisconnected);
    client.on('outputChanged', onOutputChanged);

    node.status({ fill: 'blue', shape: 'ring', text: 'connecting…' });
    reconcile();

    function buildWrite(payload: unknown): OutputWrite | null {
      if (typeof payload === 'number') {
        return { channel, config: { mode: configuredMode }, setpoint: clamp01(payload) };
      }
      if (typeof payload === 'boolean') {
        return { channel, config: { mode: configuredMode }, setpoint: payload ? 1 : 0 };
      }
      if (payload && typeof payload === 'object') {
        const p = payload as { config?: OutputWrite['config']; setpoint?: number | null };
        if ('config' in p || 'setpoint' in p) {
          const write: OutputWrite = { channel };
          if ('config' in p) write.config = p.config;
          if ('setpoint' in p) write.setpoint = p.setpoint;
          return write;
        }
      }
      return null;
    }

    node.on('input', async (msg: NodeMessageInFlow, _send: (msg: any) => void, done: (err?: Error) => void) => {
      const write = buildWrite(msg.payload);
      if (!write) { done(); return; }
      try {
        const state = await client.setOutput(write);
        if (typeof write.setpoint === 'number') lastSetpoint = write.setpoint;
        showState(state);
        // Output messages are emitted from the 'outputChanged' handler so a
        // no-op write produces no message; here we only reflect status.
        done();
      } catch (err) {
        showError(err);
        done(err as Error);
      }
    });

    node.on('close', () => {
      client.removeListener('ready', onReady);
      client.removeListener('disconnected', onDisconnected);
      client.removeListener('outputChanged', onOutputChanged);
    });
  }

  RED.nodes.registerType('digital-output', DigitalOutputNode);
};

export = digitalOutput;
