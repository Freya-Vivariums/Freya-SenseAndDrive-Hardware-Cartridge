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
import { ActuatorsDriver } from '@freya-vivariums/freya-hardware-cartridge';

interface NodeConfig extends NodeDef {
  name: string;
  actuator: string;
  channel: string;
  mode: string;
}

const digitalOutput: NodeInitializer = (RED: NodeAPI) => {
  function DigitalOutputNode( this: Node, config: NodeConfig ) {
    RED.nodes.createNode(this, config);
    const node = this;

    const actuator = config.actuator;
    const channel = parseInt(config.channel as any) || 0;
    const mode = config.mode;

    const actuatorsDriver = new ActuatorsDriver();

    // On status events from the driver
    actuatorsDriver.on('status',(status:any)=>{
        switch (status.level){
            case 'ok':      node.status({ fill: 'green', shape: 'dot', text: status.message });
                            break;
            case 'warning': node.status({ fill: 'yellow', shape: 'dot', text: status.message });
                            break;
            default:        node.status({ fill: 'red', shape: 'dot', text: status.message });
                            break;
        }
        
    })


  node.on('input', async (msg: NodeMessageInFlow, send: (msg: any) => void, done: (err?: Error) => void) => {
    try {
      // First check if there's a payload that's an object
      if ( msg.payload != null && typeof msg.payload === 'object') {
        // Get the value of the object out that has the name of this actuator
        const rawValue = (msg.payload as any)[actuator];
        // If our raw value is not undefined, it's for us to process
        if (typeof rawValue !== 'undefined') {
          // When the operation mode is digital (on/off), treat everything
          // that looks like 'true' as true. It's Node-RED, right!
          if(mode === 'digital'){
            const state = (rawValue === true || rawValue === "true" || rawValue === 1 || rawValue === "1" || rawValue === 'on')?true:false;
            // Set the actual digital output
            actuatorsDriver.setDigitalOutput(channel, state)
              .then((res)=>{
                // The response from this method is a boolean: true for success, false for failed
                if(res) node.status({ fill: 'green', shape: 'dot', text: `D${channel} turned ${state ? 'on' : 'off'}` });
                else node.status({ fill: 'yellow', shape: 'dot', text: 'Invalid request' });
              })
              .catch((err)=>{
                  node.status({ fill: 'yellow', shape: 'dot', text: err });
              });
            }
            else if( mode === 'pwm'){
              // TODO: implement other modes!
            }
        }
      }
    } catch (err) {
      node.status({ fill: 'red', shape: 'dot', text: "Failed to set output" });
      done(err as Error);
      return;
    }
    done();
    });
  }

  RED.nodes.registerType( 'digital-output', DigitalOutputNode );
};

export = digitalOutput;
