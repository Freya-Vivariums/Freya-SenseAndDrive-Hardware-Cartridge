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
 * Provides the ActuatorsDriver class for connecting to and controlling
 * the Freya Hardware Cartridge digital outputs.
 *
 * @copyright 2025 Sanne "SpuQ" Santens
 * @license MIT
 */

const dbus = require('dbus-native');
import { EventEmitter } from 'events';

export class ActuatorsDriver extends EventEmitter {
  private iface: any;                   // The interface of the System's actuator driver
  private bus = dbus.systemBus();       // The DBus interface

  constructor() {
    super();
    this.init();
  }

  async init() {
    try {
      await this.initDriverConnection();
      console.log('Connected to actuators driver');
      this.emit('status', { level: "ok", message: "Connected to actuators driver" });
    }
    catch (err) {
      console.error('Error connecting to actuators driver:', err);
      this.emit('status', { level: "error", message: "No connection to driver" });
      setTimeout(() => { this.init() }, 5 * 1000);
    }
  }

  /**
   * Initialize D-Bus connection and proxy interface
   */
  async initDriverConnection(): Promise<void> {
    const service = this.bus.getService('freya.cartridge.sensendrive');
    this.iface = await new Promise((resolve, reject) => {
      service.getInterface('/freya/cartridge/sensendrive', 'freya.cartridge.sensendrive', (err: Error | null, iface: any) => {
        if (err) {
          reject(err);
        } else {
          resolve(iface);
        }
      });
    });
  }

  /**
   * Set a digital output channel on or off.
   * @param channel - integer channel number
   * @param state - true to turn on, false to turn off
   * @returns boolean indicating success
   */
  async setDigitalOutput(channel: number, state: boolean): Promise<boolean> {
    if (!this.iface) {
      throw new Error('Driver not initialized. Call init() first.');
    }
    return new Promise((resolve, reject) => {
      this.iface.setDigitalOutput(
        channel,
        state,
        (err: Error | null, result: boolean) => {
          if (err) {
            reject(err);
          } else {
            resolve(result);
          }
        }
      );
    });
  }
}
