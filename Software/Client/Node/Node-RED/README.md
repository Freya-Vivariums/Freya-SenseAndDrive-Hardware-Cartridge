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

## Node: Freya Hardware Cartridge
Connects to the `io.freya.SystemActuatorsDriver` D-Bus service and controls the 6 digital outputs of the Hardware Cartridge. Configure the actuator name (used to filter incoming messages), the physical output channel (1–6), and the operation mode (`on/off`).

## License & Collaboration
**Copyright© 2025 Sanne 'SpuQ' Santens**. This project is licensed under the **[MIT License](LICENSE.txt)**. The [Rules & Guidelines](https://github.com/Freya-Vivariums/.github/blob/main/brand/Freya_Trademark_Rules_and_Guidelines.md) apply to the usage of the Freya Vivariums™ brand.

### Collaboration
If you'd like to contribute to this project, please follow these guidelines:
1. Fork the repository and create your branch from `main`.
2. Make your changes and ensure they adhere to the project's coding style and conventions.
3. Test your changes thoroughly.
4. Ensure your commits are descriptive and well-documented.
5. Open a pull request, describing the changes you've made and the problem or feature they address.
