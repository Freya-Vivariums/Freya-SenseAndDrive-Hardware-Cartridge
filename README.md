![Freya banner](https://raw.githubusercontent.com/Freya-Vivariums/.github/refs/heads/main/brand/Freya_banner.png)

<img src="Documentation/SenseAndDrive_Cartridge.png" align="right" width="40%"/>

The **Sense'n'Drive Hardware Cartridge** equips the [Edgeberry™](https://edgeberry.github.io) based controller with the capability for connecting sensors and driving actuators.

**Features**
- **6 digital outputs** for driving actuators directly or with interposing relays, with internal or external power source.
- **An I²C port** level-shifted to 5V for reliably connecting to the [Freya "Terra" Sensor](https://github.com/Freya-Vivariums/Freya-Terra-Sensor)

<br clear="right"/>

## Usage

<img src="Documentation/SenseAndDrive_Cartridge_enclosure.png" align="left" width="40%"/>

The Sense'n'Drive Hardware Cartridge is slided in into the expansion slot on the back side of the controller. For using it in your application, install the driver from this repository and include the sdk library in your software.



```js
const { SenseNDriveClient } = require('@freya-vivariums/freya-hardware-cartridge');

const cartridge = new SenseNDriveClient();

cartridge.on('ready', async () => {
  await cartridge.setOutput({ channel: 1, config: { mode: 'switch' }, setpoint: 1 });
  setTimeout(() => cartridge.setOutput({ channel: 1, setpoint: 0 }), 1000);
});
```

<br clear="left"/>

## Hardware

### Sensor Port
The I²C sensor port is **level-shifted to 5V**, and wired to the `HY2.0-4P` connector (informally known as the _Grove connector_) in the following way - making it directly compatible with a wide range of I²C breakout boards from a variety of ecosystems.

|  Pin   | Function |
|--------|----------|
| 1      | SCL      |
| 2      | SDA      |
| 3      | +5V      |
| 4      | GND      |

> [!NOTE]
> Before you can use the I²C port `/dev/i2c-1` on Raspberry Pi, it must be enabled by running`sudo raspi-config nonint do_i2c 0`. Or by configuring the overlay manually.

### Digital Outputs
The digital outputs are **sourcing MOSFET** channels rated for up to 1A each, suitable for driving standard industrial actuators such as relays, contactors and solenoids. Output voltage follows the externally applied supply. At 24V DC, the outputs conform to the conventional sourcing digital output arrangement described in IEC 61131-2, so any actuator designed for a standard PLC output can be connected directly. Built-in flyback diodes clamp inductive loads.

> [!IMPORTANT]
> **The digital outputs do not feature internal short-circuit or overcurrent protection**. It is recommended to install a 1A or 1.25A fast-acting fuse on the power supply line.

> [!WARNING]
> The hardware cartridge is designed with a **shared ground for all voltages (non-isolated)**. Always ensure the power supply for the digital outputs and the power supply for the device share a common ground.

The Raspberry Pi GPIO pins are connected to the digital outputs as following:

|Channel |  GPIO  | Software Driver Channel |
|--------|-----------------|------------------|
| D1     | GPIO21 | 1       |
| D2     | GPIO20 | 2       |
| D3     | GPIO16 | 3       |
| D4     | GPIO13 | 4       |
| D5     | GPIO12 | 5       |
| D6     | GPIO18 | 6       | 

> [!NOTE]
> Controling the digital outputs can be done directly from the commandline using `pinctrl`. For example `pinctrl set 21 op dh` to use GPIO21 as a digital output and set high.

## Software
The **Sense'n'Drive Hardware Cartridge driver** included in the repository is a systemd service (`freya.cartridge.sensendrive`) that is interacted with via a D-Bus API by the client libraries. The service provides methods for controlling the digital outputs in several operating modes.

### D-Bus API
System bus service and interface `freya.cartridge.sensendrive`. Methods are `(s) → s`: a bare JSON request in,
an enveloped JSON response out.


| Method | Request | Result |
|---|---|---|
| `GetOutputs` | `{}` | `{ "outputs": [ ...6...] }` |
| `SetOutput` | one write document | the resulting state |
| `SetOutputs` | `{ "outputs": [ ... ] }` | array of states |

#### Example
`SetOutput` request argument string:
```json
{
  "channel": 2,
  "config": { "mode": "pulse", "frequency_hz": 0.1, "rampRate": 0 },
  "setpoint": 0.321
}
```
Response string:
```json
{ "ok": false, "error": { "code": "EINVAL", "message": "..." } }
```
Or
```json
{ "ok": true, "result": {
    "channel": 2,
    "config": { "mode": "pulse", "frequency_hz": 0.1, "rampRate": 0 },
    "setpoint": 0.321,
    "actual": 0.3 } }
```

Signals: `Ready` at startup, and `OutputChanged` carrying one state document
whenever a channel changes.

## License & Collaboration
**Copyright© 2024-2026 Sanne 'SpuQ' Santens**. The hardware and enclosure are released under the [**CERN OHL-W**](Hardware/LICENSE.txt) license. The driver is released under the [**GNU GPL-3.0**](Software/Driver/LICENSE.txt) license and the sdk libraries under the [**MIT license**](Software/Client/LICENSE.txt) Trademark rules apply to the [Freya™ brand](https://github.com/Freya-Vivariums/.github/blob/main/brand/Freya_Trademark_Rules_and_Guidelines.md).

### Collaboration

If you'd like to contribute to this project, please follow these guidelines:
1. Fork the repository and create your branch from `main`.
2. Make your changes and ensure they adhere to the project's design style and conventions.
3. Test your changes thoroughly.
4. Ensure your commits are descriptive and well-documented.
5. Open a pull request, describing the changes you've made and the problem or feature they address.
