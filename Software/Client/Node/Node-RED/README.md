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
- `off` — output driven low. *(available)*
- `switch` — on/off; output high when the setpoint is ≥ 0.5. *(available)*
- `pwm-slow` — slow pulse-width modulation (0.001–1 Hz). *(not yet implemented)*
- `pwm` — pulse-width modulation (1–30 Hz). *(not yet implemented)*

The two PWM modes, along with the **Frequency** and **Ramp rate** fields, appear
in the edit dialog but are disabled and marked *not yet implemented*; they are
placeholders for a future release.

## License & Collaboration
**Copyright© 2025 Sanne 'SpuQ' Santens**. This project is licensed under the **[MIT License](LICENSE.txt)**. The [Rules & Guidelines](https://github.com/Freya-Vivariums/.github/blob/main/brand/Freya_Trademark_Rules_and_Guidelines.md) apply to the usage of the Freya Vivariums™ brand.

### Collaboration
If you'd like to contribute to this project, please follow these guidelines:
1. Fork the repository and create your branch from `main`.
2. Make your changes and ensure they adhere to the project's coding style and conventions.
3. Test your changes thoroughly.
4. Ensure your commits are descriptive and well-documented.
5. Open a pull request, describing the changes you've made and the problem or feature they address.
