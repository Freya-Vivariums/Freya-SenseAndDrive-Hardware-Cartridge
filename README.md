![Freya banner](https://raw.githubusercontent.com/Freya-Vivariums/.github/refs/heads/main/brand/Freya_banner.png)

<img src="documentation/SenseAndDrive_Cartridge.png" align="right" width="50%"/>

The **Sense'n'Drive Hardware Cartridge** provides your [Edgeberry](https://github.com/Edgeberry)-based Freya Vivarium Control System with 6 digital outputs and an I²C sensor port.

The Raspberry Pi's I²C bus is levelshifted to 5V, enabling compatibility with a wide range of peripheral components. The bus is routed to a 4P-2.0mm D90 connector, compatible with the Grove standard.

The digital outputs are P-channel MOSFETs configured for sourcing. An external power source can be applied to drive the digital outputs, or the base board's power source can be used by internally wiring the dedicated connectors.

<br clear="right"/>

## Usage
### I²C
Enable the I²C port using `raspi-config`:
```
$ sudo raspi-config
> 3     Interface options
> I5    I2C
> Enable
```
Now you can use the I²C interface `/dev/i2c-1` for connecting peripheral components.

### Digital Outputs
The digital outputs are connected as following:
|  GPIO  | OUTPUT |
|--------|--------|
| GPIO21 | D1     |
| GPIO20 | D2     |
| GPIO16 | D3     |
| GPIO13 | D4     |
| GPIO12 | D5     |
| GPIO18 | D6     |

Controling the digital outputs can be done from the commandline using `pinctrl`.
```
pinctrl set 21 op dh
```
**'op' meaning 'output', 'dh' digital high, 'dl' digital low.*

## License & Collaboration
**Copyright© 2024 Sanne 'SpuQ' Santens**. This project is released under the **CERN OHL-W** license. The [Rules & Guidelines](https://github.com/Edgeberry/.github/blob/main/brand/Edgeberry_Trademark_Rules_and_Guidelines.md) apply to the usage of the Edgeberry™ brand.

### Collaboration

If you'd like to contribute to this project, please follow these guidelines:
1. Fork the repository and create your branch from `main`.
2. Make your changes and ensure they adhere to the project's design style and conventions.
3. Test your changes thoroughly.
4. Ensure your commits are descriptive and well-documented.
5. Open a pull request, describing the changes you've made and the problem or feature they address.
