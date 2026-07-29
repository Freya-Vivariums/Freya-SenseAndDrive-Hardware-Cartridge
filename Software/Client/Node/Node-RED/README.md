![Freya Banner](https://raw.githubusercontent.com/Freya-Vivariums/.github/refs/heads/main/brand/Freya_banner.png)

<img src="https://nodered.org/about/resources/media/node-red-icon.png" align="right" width="10%"/>

**[Node-RED](https://nodered.org/)** is a visual programming tool that lets you wire together hardware, APIs, and online services by connecting blocks in a flow-based editor. The **Freya Hardware Cartridge** Node-RED node lets you control the digital outputs of the Freya SenseAndDrive Hardware Cartridge directly from your Node-RED flows over D-Bus.

<br clear="right"/>

[![npm](https://img.shields.io/npm/v/@freya-vivariums/freya-hardware-cartridge-node-red-contrib)](https://www.npmjs.com/package/@freya-vivariums/freya-hardware-cartridge-node-red-contrib)

## Installation
#### Node-RED flow editor
Navigate to `Settings > Manage Palette`, then in the `Install` tab, search for `@freya-vivariums/freya-hardware-cartridge-node-red-contrib` and click the `Install` button.

#### Manually using NPM
On your device, navigate to the Node-RED folder (on a Freya system, it's at `/opt/Freya/nodered`), and run:
```
npm install @freya-vivariums/freya-hardware-cartridge-node-red-contrib
```

## Node: Digital Output
Controls one of the 6 outputs of the Hardware Cartridge. All Digital Output
nodes automatically share a single connection to the `freya.cartridge.sensendrive`
system D-Bus service, so no separate configuration node is needed. Configure the
physical output channel (1–6) and the mode.

**Input** (`msg.payload`):
- a number `0.0`–`1.0` sets the channel setpoint;
- a boolean maps to a setpoint of `0` / `1`;
- a partial write object `{ config, setpoint }` for full control.

**Output:** a message whose `payload` is the channel state document, emitted
whenever the channel's realized state changes.

**Modes:**
- **Off** (`off`) — output driven low.
- **On/Off** (`switch`) — output high when the realized value is ≥ 0.5.
- **Pulse** (`pwm-slow`) — slow pulse-width modulation, **0.001–1 Hz**. Duty
  cycle equals the setpoint (e.g. 0.1 Hz at 0.3 → 3 s on / 7 s off every 10 s).
- **PWM** (`pwm`) — pulse-width modulation, **1–60 Hz**. The 60 Hz ceiling is
  bounded by the `pinctrl` process-spawn rate (one process per edge, ~1.6 ms
  median / ~7 ms worst on a Raspberry Pi 5); duty accuracy softens toward the
  top of the range. ("PWM fast" is reserved for a future tier.)

  The frequency cap is not the only limit: because each edge costs a process
  spawn, the shortest resolvable on-time is **~5 ms**, and at low duty that
  minimum binds before the frequency does. 60 Hz is fine at 50 % duty (~8 ms
  on-time) but not at 5 % (~0.8 ms). This is not enforced — extreme
  duty/frequency pairs simply degrade gracefully rather than being rejected.

**Frequency** is required for the two PWM modes and rejected out of range; it is
ignored (and hidden) for Off / On/Off. **Ramp rate** is a soft start/stop in
setpoint units per second (`0` = instant); it slides the realized value toward
the setpoint, delaying the On/Off threshold crossing or the PWM duty change.

**Ramping applies in every mode except `off`.** Selecting **Off** is a hard,
immediate stop — it snaps the output low regardless of ramp rate. To fade an
output down instead, keep its mode and set the setpoint to `0`: **`setpoint: 0`
fades, `mode: off` snaps.**

## License & Collaboration
**Copyright© 2025 Sanne 'SpuQ' Santens**. This project is licensed under the **[MIT License](LICENSE.txt)**. The [Rules & Guidelines](https://github.com/Freya-Vivariums/.github/blob/main/brand/Freya_Trademark_Rules_and_Guidelines.md) apply to the usage of the Freya Vivariums™ brand.

### Collaboration
If you'd like to contribute to this project, please follow these guidelines:
1. Fork the repository and create your branch from `main`.
2. Make your changes and ensure they adhere to the project's coding style and conventions.
3. Test your changes thoroughly.
4. Ensure your commits are descriptive and well-documented.
5. Open a pull request, describing the changes you've made and the problem or feature they address.
