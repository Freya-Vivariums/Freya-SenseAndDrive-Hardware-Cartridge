/*
 *  Freya System Actuators Driver
 *  The hardware-dependent component of the Freya Vivarium Control System, designed
 *  for use with the Edgeberry hardware (Base Board + Sense'n'Drive hardware cartridge).
 *
 *  Copyright© 2025 Sanne “SpuQ” Santens
 *  Released under the MIT License (see LICENSE.txt)
 */

const dbus = require('dbus-native');
import { exec } from 'child_process';

// DBus service constants
const DBUS_SERVICE = 'io.freya.SystemActuatorsDriver';
const DBUS_PATH = '/io/freya/SystemActuatorsDriver';
const DBUS_INTERFACE = 'io.freya.SystemActuatorsDriver';

// Edgeberry's Sense'n'Drive Hardware Cartridge Digital outputs mapping
const channels = [
  /* channel 1 */ 21, // Main lights
  /* channel 2 */ 20, // Heater
  /* channel 3 */ 16, // Misting pump
  /* channel 4 */ 13, // (unused)
  /* channel 5 */ 12, // Ventilation
  /* channel 6 */ 18  // Auxiliary lights
];

// Connect to the system D-Bus
const systemBus = dbus.systemBus();

/**
 *  init()
 *  Initialize the driver: acquire DBus name and export interface,
 *  Initialize all channels to digital low.
 */
async function init(){
    // Initialize our DBus service
    if(systemBus){
        console.log('\x1b[32mD-Bus client connected to system bus\x1b[30m');
        try{
            await registerDbusName();
            createDbusInterface();
        }
        catch(e){
            cleanup(1);
        }
    }
    else{
        console.error('\x1b[31mD-Bus client could not connect to system bus\x1b[30m');
        cleanup(1);
    }

    // Turn all outputs off
    setAllOutputsOff()
}

init();

/**
 *  cleanup()
 *  Clean up resources; release D-Bus name and turn off all outputs.
 */
function cleanup(statuscode:number) {
    console.log('');

    // Release the D-Bus name (dbus-daemon will clean up on exit
    // anyway, but it’s polite to do so ourselfs):
    systemBus.releaseName(DBUS_SERVICE, (err:any) => {
        if (err)
            console.warn('Failed to release bus name:', err);
        else
            console.log(`Released D-Bus name "${DBUS_SERVICE}"`);
    });

    // Turn all outputs off
    setAllOutputsOff();

    // Clean exit
    process.exit(statuscode);
}

/*
 *  System events
 *
 */
// catch the system signals (when the process is kindly requested to stop)
process.on('SIGTERM', ()=>cleanup(0));
process.on('SIGINT', ()=>cleanup(0));
// catch uncaught exceptions so you can clean up there too
process.on('uncaughtException', err => {
    console.error('Uncaught exception:', err);
    cleanup(1);
});

/*
 *  Actuator controls
 */


/* 
 * SetDigitalOutput()
 * Set a digital output channel of the Edgeberry Sense'n'Drive 
 * Hardware Cartridge high or low via gpio-pinctrl
 * @param channel Logical channel number (1-6)
 * @param state   true = high / on, false = low / off
 * @returns       true on success, false on failure or invalid channel
 */
function setDigitalOutput( channel:number, state:boolean ):boolean{
    // Check whether the Channel value is correct
    if( channel <1 || channel >6){
        console.log("Digital output "+channel+" does not exist")
        return false;
    }
    // Translate the channel number to the corresponding digital pin
    const digitalPin = channels[channel-1];
    // Translate the boolean state to the corresponding instruction
    const digitalState = state?'dh':'dl';
    try{
        exec("pinctrl set "+digitalPin+" op "+digitalState);
        return true;
    }
    catch(e){
        console.warn("Failed to set Digital Output: "+e);
        return false;
    }
}

/* 
 * SetAllOutputsOff()
 * Turns all digital output channels of the Edgeberry Sense'n'Drive 
 * Hardware Cartridge off
 */
function setAllOutputsOff(){
    let i=1;
    while( i <= 6){
        setDigitalOutput( i, false);
        i++;
    }
}

/*
 *  DBus
 */


/* DBus service object */
const serviceObject = {
                        setDigitalOutput: (channel:number, state:boolean)=>{
                          return setDigitalOutput( channel, state );
                        },
                        emit: (signalName:string, ...otherParameters:any )=>{}
                      }
/*
 *  Register D-Bus name
 */
function registerDbusName():Promise<void>{
    return new Promise((resolve, reject)=>{
        // If we're not connected to the system DBus, don't even bother
        // to continue...
        if(!systemBus) reject(new Error('No system bus available'));
        // Request our DBus service name
        systemBus.requestName(DBUS_SERVICE,0, (err:any, res:number)=>{
            if(err){
                console.warn('\x1b[31mD-Bus service name aquisition failed: '+err+'\x1b[30m');
                reject();
            }
            if( res !== 1){
                console.warn('\x1b[31mUnexpected reply while requesting DBus service name: ' + res + '\x1b[30m');
                reject(new Error('Unexpected reply: ' + res));
            }
            else
                console.log('\x1b[32mD-Bus service name "'+DBUS_SERVICE+'" successfully aquired \x1b[30m');
                resolve();
        });
    })
}

/*
 *  Create D-Bus interface
 */
function createDbusInterface(){
    systemBus.exportInterface( serviceObject, DBUS_PATH, {
        name: DBUS_INTERFACE,
         methods: {
            setDigitalOutput: [ 'ib', 'b' ],
            getDigitalOutput: [ 'i',  'b' ]
        },
        signals: {
            updateActuator:['s']
        }
    });
    console.log('D-Bus interface exported. Ready to accept calls.');
}