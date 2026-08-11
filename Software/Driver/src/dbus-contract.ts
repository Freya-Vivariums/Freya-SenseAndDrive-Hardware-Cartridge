/*
 *  Freya System Actuators Driver - D-Bus interface contract
 *
 *  The shapes this driver accepts and returns over D-Bus. The driver serves
 *  this interface; the Node.js client SDK in Software/Client/Node/Library
 *  consumes it and declares the same shapes on its own side.
 *
 *  These are deliberately duplicated rather than imported from the client SDK:
 *  the driver is the component that owns the interface, and it must build and
 *  release without depending on any client. The contract between the two is the
 *  D-Bus JSON payload, not a shared npm package - so if a shape changes here,
 *  it has to change in the client SDK too.
 *
 *  Copyright© 2025 Sanne “SpuQ” Santens
 *  Released under the GNU General Public License v3.0 (see LICENSE.txt)
 *
 *  SPDX-License-Identifier: GPL-3.0-or-later
 */

export type ChannelMode = 'off' | 'switch' | 'pulse';

export interface ChannelConfig {
  mode: ChannelMode;
  /** Pulse frequency (0.001-60 Hz); required for `pulse` mode, `null` in `off`/`switch`. */
  frequency_hz: number | null;
  /** Ramp speed in setpoint units per second (>= 0). 0 = no ramp (actual jumps to setpoint). */
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

export type SenseNDriveErrorCode = 'ECHANNEL' | 'EMODE' | 'EINVAL' | 'EIO' | 'EINTERNAL' | 'EJSON';
