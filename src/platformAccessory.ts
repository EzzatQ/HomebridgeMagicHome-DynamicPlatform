import { CharacteristicEventTypes } from 'homebridge';
import type {
  Service, PlatformConfig, PlatformAccessory, CharacteristicValue,
  CharacteristicSetCallback, CharacteristicGetCallback,
} from 'homebridge';
import { clamp, convertHSLtoRGB, convertRGBtoHSL, convertWhitesToColorTemperature } from './magichome-interface/utils';
import { HomebridgeMagichomeDynamicPlatform } from './platform';
import { Transport } from './magichome-interface/Transport';
import { getLogger } from './instance';
import { ILightState, opMode } from './magichome-interface/types';
import { LightStateMachine} from './LightStateMachine';

const COMMAND_POWER_ON = [0x71, 0x23, 0x0f];
const COMMAND_POWER_OFF = [0x71, 0x24, 0x0f];

/* 
   Homekit send some "split commands", that is, instead of sending single command message for "TurnOn at Brightness at 50%", it sends two messages one "TurnOn" and another "Set Brightness at 50%".
   
   However, the light works better when you send a single command mesasge to it, so our code we wait for some time for a subsequent message. The INTRA_MESSAGE_TIME sets the time we wait since last received message. 

*/
const INTRA_MESSAGE_TIME = 5; 

/*
  We notice that if you send a command to the light, and read the status back right away, the status comes back with the old reading.
  For proper operation, we wait some time between the write and read back, so the lamp reports accurate state.r status
*/
const DEVICE_READBACK_DELAY = 500;

const DEFAULT_LIGHT_STATE: ILightState = {
  isOn: true,
  operatingMode: opMode.redBlueGreenMode,
  HSL: { hue: 255, saturation: 100, luminance: 50 },
  RGB: { red: 0, green: 0, blue: 0 },
  whiteValues: { warmWhite: 0, coldWhite: 0 },
  colorTemperature: null,
  brightness: 100,
  targetState: {   targetHSL: { hue:null, saturation:null, luminance:null}, 
    targetMode: null, targetOnState: null, targetColorTemperature:null,
    targetBrightness: null,
  },
};

const animations = {
  none: { name: 'none', brightnessInterrupt: true, hueSaturationInterrupt: true },
};

interface IProcessRequest {
  msg?: string;
  timeout?: boolean;
}

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class HomebridgeMagichomeDynamicPlatformAccessory {
  protected service: Service;
  protected transport = new Transport(this.accessory.context.cachedIPAddress, this.config);
  protected colorWhiteThreshold = this.config.whiteEffects.colorWhiteThreshold;
  protected colorWhiteThresholdSimultaniousDevices = this.config.whiteEffects.colorWhiteThresholdSimultaniousDevices;
  protected colorOffThresholdSimultaniousDevices = this.config.whiteEffects.colorOffThresholdSimultaniousDevices;
  protected simultaniousDevicesColorWhite = this.config.whiteEffects.simultaniousDevicesColorWhite;

  //protected interval;
  public activeAnimation = animations.none;
  protected deviceWriteInProgress = false;
  protected deviceWriteRetry: any = null;

  log = getLogger();

  public lightStateTemporary: ILightState = DEFAULT_LIGHT_STATE
  protected lightState: ILightState = DEFAULT_LIGHT_STATE

  //=================================================
  // Start Constructor //

  constructor(
    protected readonly platform: HomebridgeMagichomeDynamicPlatform,
    protected readonly accessory: PlatformAccessory,
    public readonly config: PlatformConfig,
  ) {

    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Magic Home')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, accessory.context.device.uniqueId)
      .setCharacteristic(this.platform.Characteristic.Model, accessory.context.device.modelNumber)
      .setCharacteristic(this.platform.Characteristic.FirmwareRevision, accessory.context.device.lightVersion)
      .getCharacteristic(this.platform.Characteristic.Identify)
      .on(CharacteristicEventTypes.SET, this.identifyLight.bind(this));       // SET - bind to the 'Identify` method below

    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .addOptionalCharacteristic(this.platform.Characteristic.ConfiguredName);


    // get the LightBulb service if it exists, otherwise create a new LightBulb service
    // you can create multiple services for each accessory
    if(this.accessory.context.lightParameters.hasBrightness || this.accessory.context.lightParameters.hasBrightness == undefined){
            
      if (this.accessory.getService(this.platform.Service.Switch)) {
        this.accessory.removeService(this.accessory.getService(this.platform.Service.Switch));
      }
      this.service = this.accessory.getService(this.platform.Service.Lightbulb) ?? this.accessory.addService(this.platform.Service.Lightbulb);
      this.accessory.context.lightParameters.hasBrightness = true;

      this.service.getCharacteristic(this.platform.Characteristic.ConfiguredName)
        .on(CharacteristicEventTypes.SET, this.setConfiguredName.bind(this));
    
      // each service must implement at-minimum the "required characteristics" for the given service type
      // see https://developers.homebridge.io/#/service/Lightbulb

      // register handlers for the Brightness Characteristic
      this.service.getCharacteristic(this.platform.Characteristic.Brightness)
        .on(CharacteristicEventTypes.SET, this.setBrightness.bind(this))        // SET - bind to the 'setBrightness` method below
        .on(CharacteristicEventTypes.GET, this.getBrightness.bind(this));       // GET - bind to the 'getBrightness` method below

      // //get, set
      // this.service.getCharacteristic(this.platform.Characteristic.Brightness.CharacteristicValueTransitionControl)
      //   .on(CharacteristicEventTypes.SET, this.setCVT.bind(this))
      //   .on(CharacteristicEventTypes.GET, this.getCVT.bind(this));
        
      // // get
      // this.service.getCharacteristic(this.platform.Characteristic.Brightness.SupportedCharacteristicValueTransitionConfiguration)
      //   .on(CharacteristicEventTypes.GET, this.getSupportedCVT.bind(this));


      if( this.accessory.context.lightParameters.hasColor){
        // register handlers for the Hue Characteristic
        this.service.getCharacteristic(this.platform.Characteristic.Hue)
          .on(CharacteristicEventTypes.SET, this.setHue.bind(this))               // SET - bind to the 'setHue` method below
          .on(CharacteristicEventTypes.GET, this.getHue.bind(this));              // GET - bind to the 'getHue` method below

        // register handlers for the Saturation Characteristic
        this.service.getCharacteristic(this.platform.Characteristic.Saturation)
          .on(CharacteristicEventTypes.SET, this.setSaturation.bind(this))        // SET - bind to the 'setSaturation` method below
        // TODO: why get saturation is not needed?
          .on(CharacteristicEventTypes.GET, this.getSaturation.bind(this));       // GET - bind to the 'getSaturation` method below
        // register handlers for the On/Off Characteristic
      
        // register handler for Color Temperature Characteristic
        if(this.config.advancedOptions?.useColorTemperature){
          this.platform.log.info('[EXPERIMENTAL] Registering ColorTemperature for device ',this.accessory.context.displayName);
          this.service.getCharacteristic(this.platform.Characteristic.ColorTemperature)
            .on(CharacteristicEventTypes.SET, this.setColorTemperature.bind(this)) 
            .on(CharacteristicEventTypes.GET, this.getColorTemperature.bind(this));  
        }

      }
    } else {

      this.service = this.accessory.getService(this.platform.Service.Switch) ?? this.accessory.addService(this.platform.Service.Switch);
      this.service.getCharacteristic(this.platform.Characteristic.ConfiguredName)
        .on(CharacteristicEventTypes.SET, this.setConfiguredName.bind(this));

    }
    // register handlers for the On/Off Characteristic
    this.service.getCharacteristic(this.platform.Characteristic.On)
      .on(CharacteristicEventTypes.SET, this.setOn.bind(this))              // SET - bind to the `setOn` method below
      .on(CharacteristicEventTypes.GET, this.getOn.bind(this));               // GET - bind to the `getOn` method below
    //this.service2.updateCharacteristic(this.platform.Characteristic.On, false);
    this.updateLocalState();
    // set the service name, this is what is displayed as the default name on the Home app
    // in this example we are using the name we stored in the `accessory.context` in the `discoverDevices` method.
    this.service.setCharacteristic(this.platform.Characteristic.Name, this.accessory.displayName);
  

  }

  //=================================================
  // End Constructor //

  //=================================================
  // Start Setters //

  setConfiguredName(value: CharacteristicValue, callback: CharacteristicSetCallback) {
    const name: string = value.toString();
    this.platform.log.debug('Renaming device to %o', name);
    this.accessory.context.displayName = name;
    this.platform.api.updatePlatformAccessories([this.accessory]);
    callback(null);
  }

  identifyLight() {
    this.platform.log.info('Identifying accessory: %o!',this.accessory.displayName);
    // this.flashEffect();
    this.readBackTest();
  }

  async readBackTest(){
    this.processRequest({msg: 'test123'});
    this.processRequest({msg: 'test123'});
    this.processRequest({msg: 'test123'});

    await this.sleep(100);
    this.processRequest({msg: 'test123'});
    this.processRequest({msg: 'test123'});
    this.processRequest({msg: 'test123'});

    let state;
    const delay = 500;
    this.platform.log.info('Performing read back test: %o!',this.accessory.displayName);
    // set device on
    await this.send(COMMAND_POWER_OFF);
    // wait 1 sec to proagate2

    await this.sleep(2000);
    // set off
    await this.send(COMMAND_POWER_ON);
    await this.sleep(delay);
    state = await this.transport.getState(1000); //retrieve a state object from transport class showing light's current r,g,b,ww,cw, etc
    // 

    if(state.isOn === true){
      this.platform.log.info(`Test SUCCESS - decrease delay ${delay}`);
    } else {
      this.platform.log.info(`Test FAILED - increase delay ${delay}`);
      this.platform.log.info(`Test result: ${this.accessory.displayName}: `, state);
    }
    await this.send([0x31, 127, 127, 127, 127, 127, 0x0F, 0x0F], true, 1000); //9th byte checksum calculated later in send()
    await this.sleep(1000);

    await this.send([0x31, 127, 127, 127, 127, 127, 0xFF, 0x0F], true, 1000); //9th byte checksum calculated later in send()
    await this.sleep(delay);
    state = await this.transport.getState(1000); //retrieve a state object from transport class showing light's current r,g,b,ww,cw, etc
    // 

    if(state.whiteValues.warmWhite === 127){
      this.platform.log.info(`Test2 SUCCESS ${state.whiteValues.warmWhite} - decrease delay ${delay}`);
    } else {
      this.platform.log.info(`Test2 FAILED ${state.whiteValues.warmWhite}- increase delay ${delay}`);
      //this.platform.log.info(`Test2 result: ${this.accessory.displayName}: `, state);
    }
    this.platform.log.info(`Test2 result: ${this.accessory.displayName}: `, state);

    //read
    // compare

  }


  setHue(value: CharacteristicValue, callback: CharacteristicSetCallback) {
    this.lightState.targetState.targetHSL.hue = value as number;
    this.lightState.targetState.targetMode = opMode.redBlueGreenMode;
    this.lightState.HSL.hue = value as number; 
    this.processRequest({ msg: `hue=${value}`});
    callback(null);
  }

  setSaturation(value: CharacteristicValue, callback: CharacteristicSetCallback) {
    this.lightState.targetState.targetHSL.saturation = value as number;
    this.lightState.targetState.targetMode = opMode.redBlueGreenMode;
    this.lightState.HSL.saturation = value as number; 
    this.processRequest({ msg: `sat=${value}`});
    callback(null);
  }

  setBrightness(value: CharacteristicValue, callback: CharacteristicSetCallback) {
    this.lightState.targetState.targetBrightness =  value as number;
    this.lightState.brightness = value as number; 
    this.processRequest({msg: `bri=${value}`});
    callback(null);
  }

  async setColorTemperature(value: CharacteristicValue, callback: CharacteristicSetCallback){
    this.lightState.targetState.targetColorTemperature = value as number;
    this.lightState.targetState.targetMode = opMode.temperatureMode;
    this.processRequest({msg: `cct=${value}`} );
    callback(null);
  }

  setOn(value: CharacteristicValue, callback: CharacteristicSetCallback) {
    this.lightState.targetState.targetOnState = value as boolean;
    this.processRequest({msg: `on=${value}`});
    callback(null);
  }

  protected myTimer = null
  protected timestamps = []
  async processRequest(props: IProcessRequest): Promise<void>{
    const { displayName } = this.accessory.context;

    try{ 
      const { msg, timeout } = props;

      if(this.deviceWriteInProgress){
        this.platform.log.warn(`[ProcessRequest] Got message while TRANSMISSION in PROGRESS for '${displayName}'. Schedule a check in 100ms`);
        if(this.deviceWriteRetry === null){
          this.deviceWriteRetry = setTimeout( () => this.processRequest({timeout:true}), 100 );

        }
      } else {
        this.deviceWriteRetry = null;
      }

      // if a new message arrives, restart the timer
      if(msg){
        this.platform.log.debug(`[ProcessRequest] Triggered "${msg}" for device '${displayName}'`);
        this.timestamps.push(Date.now()); // log timestamps
        clearTimeout(this.myTimer);
        this.myTimer = setTimeout( () => this.processRequest({timeout: true}), INTRA_MESSAGE_TIME);
        return;
      }
      this.deviceWriteInProgress = true; //block reads of device while

      this.platform.log.debug(`[ProcessRequest] Triggered "timeout" for device '${displayName}'`);

      const printTS = (ts) => ts.length=== 0 ? [] : ts.map( e=> e-ts[0]);

      // TODO: if transmission started, then do what if new message arrives?

      const {nextState, message: stateMsg} = LightStateMachine.nextState(this.lightState);

      if(nextState === 'unchanged'){
        this.platform.log.warn(`[ProcessRequest] Timeout with no valid data. State: '${this.lightState.targetState}' for device '${displayName}' `);
        this.timestamps = [];
        this.clearTargetState();
      } else if(nextState==='keepState'){
        this.platform.log.debug(`[ProcessRequest] Skipped transmission. Type: ${stateMsg} for device '${displayName}'`);
      } else {
        const timeStart = Date.now();
        this.platform.log.debug(`[ProcessRequest] Transmission started. Type: ${stateMsg} for device '${displayName}'`);
        this.platform.log.debug('\t timestamps', printTS(this.timestamps) );
        this.timestamps = [];

        const writeStartTime = Date.now();
        nextState === 'toggleState' ?
          await this.send(this.lightState.targetState.targetOnState ? COMMAND_POWER_ON : COMMAND_POWER_OFF)
          :
          await this.updateDeviceState(); // Send message to light
        const writeElapsedTime = Date.now() - writeStartTime;
        
        this.platform.log.debug(`[ProcessRequest] waiting ${DEVICE_READBACK_DELAY} for device '${displayName}' propagation`);
        await this.sleep(DEVICE_READBACK_DELAY);

        const readStartTime = Date.now();
        await this.updateLocalState();  // Read light state, tell homekit and store as current state  
        const readElapsedTime = Date.now() - readStartTime;
        
        this.clearTargetState();        // clear state changes
        const elapsed = Date.now() - timeStart;
        this.platform.log.debug(`[ProcessRequest] Transmission complete in ${elapsed}! (w:${writeElapsedTime},r:${readElapsedTime}'. Type: ${stateMsg} for device '${displayName}'\n`);
      }
      this.deviceWriteInProgress = false; //allow reads to occur
    } catch(err){
      this.platform.log.error(`[ProcessRequest] ERROR for device '${displayName}':`, err);
      this.deviceWriteInProgress = false; //allow reads to occur
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  clearTargetState():void{
    this.lightState.targetState = {   targetHSL: { hue:null, saturation:null, luminance:null}, 
      targetMode: null, targetOnState: null, targetColorTemperature:null,
      targetBrightness: null,
    };
  }

  //=================================================
  // End Setters //

  //=================================================
  // Start Getters //

  getHue(callback: CharacteristicGetCallback) {
    this.getDeviceStatus();
    this.platform.log.debug('Get Characteristic Hue -> %o for device: %o ', this.lightState.HSL.hue, this.accessory.context.displayName);
    callback(null, this.lightState.HSL.hue);
  }

  getBrightness(callback: CharacteristicGetCallback) {
    this.getDeviceStatus();
    this.platform.log.debug('Get Characteristic Brightness -> %o for device: %o ', Math.round( this.lightState.brightness ) , this.accessory.context.displayName);
    callback(null, Math.round( this.lightState.brightness ) );
  }

  getSaturation(callback: CharacteristicGetCallback) {
    this.getDeviceStatus();
    this.platform.log.debug('Get Characteristic Saturation -> %o for device: %o ', this.lightState.HSL.saturation, this.accessory.context.displayName);
    callback(null, this.lightState.HSL.saturation);
  }

  getColorTemperature(callback: CharacteristicGetCallback){
    this.getDeviceStatus();
    const { mired } = convertWhitesToColorTemperature(this.lightState.whiteValues);
    this.platform.log.debug('Get Characteristic Color Temperature -> %o for device: %o ', mired, this.accessory.context.displayName);
    callback(null, mired);
  }

  protected lastTimeCalled = Date.now()
  async getDeviceStatus(){ //updateLocalState

    if( Date.now() - this.lastTimeCalled > 100 ){
      this.lastTimeCalled = Date.now(); 
      // if a write is inprogress, we don't bother reading lightbulb state
      // because at the end of a write, there's a read anyway
      if(this.deviceWriteInProgress === false){
        this.updateLocalState();
      } else {
        this.platform.log.debug(`Skipping read of ${this.accessory.context.displayName}, as we're about to do as part of the write`);
      }
    }
    return;
  }

  /**
   ** @getOn
   * instantly retrieve the current on/off state stored in our object
   * next call this.getState() which will update all values asynchronously as they are ready
   */
  getOn(callback: CharacteristicGetCallback) {
    //update state with actual values asynchronously
    this.getDeviceStatus();
    this.platform.log.debug('Get Characteristic On -> %o for device: %o ', this.lightState.isOn, this.accessory.context.displayName);
    callback(null, this.lightState.isOn);
  }

  getIsAnimating(callback: CharacteristicGetCallback) {
    let isAnimating = true;

    if(this.activeAnimation == animations.none) {
      isAnimating = false;
    }
    this.platform.log.debug('Get Characteristic isAnimating -> %o for device: %o ', isAnimating, this.accessory.context.displayName);
    callback(null, isAnimating);
  }

  //=================================================
  // End Getters //

  //=================================================
  // Start State Get/Set //

  calculateBrightness():number {
    const { operatingMode, HSL, whiteValues, isOn } = this.lightState;
    return isOn && HSL.luminance >=0? Math.round(HSL.luminance * 2) : 0;
  }

  /**
   ** @updateLocalState
   * retrieve light's state object from transport class
   * once values are available, update homekit with actual values
   */
  async updateLocalState() {

    try {
      let state;
      let scans = 0;

      const timer = Date.now();

      while(state == null && scans <= 5){
        state = await this.transport.getState(1000); //retrieve a state object from transport class showing light's current r,g,b,ww,cw, etc
        scans++;
      } 
      const elapsed = Date.now() - timer;
      this.platform.log.debug(`[updateLocalState] NETWORK ACCESS for '${this.accessory.context.displayName}' is ${elapsed} ms (tries: ${scans})` );

      if(state == null){
        const name = this.accessory.context.displayName;
        const { ipAddress:ip, uniqueId:mac } = this.accessory.context.device;
        this.platform.log.error(`No device response: "${name}" "${mac}" "${ip}"`);
        // TODO: report off-line here so that device shows as "no response". Use reachable?
        // this.service.updateCharacteristic(this.platform.Characteristic.Reachable, false);
        // temporary work around: report as off.
        this.lightState.isOn = false;
        await this.updateHomekitState();
        return;
      }
      this.accessory.context.lastKnownState = state;

      this.lightState.RGB = state.RGB;
      this.lightState.HSL = convertRGBtoHSL(state.RGB);
      this.lightState.whiteValues = state.whiteValues;
      const { mired } = convertWhitesToColorTemperature(state.whiteValues);
      this.lightState.colorTemperature = mired;
      this.lightState.isOn = state.isOn;
      this.lightState.operatingMode = state.operatingMode;

      // TODO: right now, the brighness is calculated in the updateHomekitState because
      //   each lamp model may have their way to calculate the brightness.
      this.lightState.brightness = 0;

      const { red, green, blue } = this.lightState.RGB;
      const { brightness, isOn} = this.lightState;
      const { coldWhite:cw, warmWhite:ww} = this.lightState.whiteValues;
      const mode = this.lightState.operatingMode;
      const str = `on:${isOn} ${mode} r:${red} g:${green} b:${blue} cw:${cw} ww:${ww} (bri:${brightness} - calculation is pending)`;
      this.platform.log.debug('[getLampState] Reporting:', str);
      // this.platform.log.debug('state.debugBuffer', state.debugBuffer);

      const updateHomeKitStartTime = Date.now();
      await this.updateHomekitState();
      const elapsedHomeKitUpdateTime = Date.now() - updateHomeKitStartTime;
      this.platform.log.debug(`[updateLocalState] elapsedHomeKitUpdateTime for '${this.accessory.context.displayName}' is ${elapsedHomeKitUpdateTime} ms` );

    } catch (error) {
      this.platform.log.error('getState() error: ', error);
    }
  }

  /**
   ** @updateHomekitState
   * send state to homekit
   */
  async updateHomekitState():Promise<any> {
    const { isOn } = this.lightState;
    const { hue, saturation, luminance } = this.lightState.HSL;

    let brightness = this.lightState.brightness;
    if( luminance > 0 && isOn ){
      brightness = luminance * 2;
      this.lightState.brightness = brightness;
    }

    this.service.updateCharacteristic(this.platform.Characteristic.On,  isOn);
    this.service.updateCharacteristic(this.platform.Characteristic.Hue, hue);
    this.service.updateCharacteristic(this.platform.Characteristic.Saturation, saturation);
    this.service.updateCharacteristic(this.platform.Characteristic.Brightness,  brightness);

    this.platform.log.debug(`Reporting to HomeKit: on=${isOn} hue=${hue} sat=${saturation} bri=${brightness} `);
  }

  updateLocalHSL(_hsl){
    this.lightState.HSL = _hsl;
  }

  updateLocalRGB(_rgb){
    this.lightState.RGB = _rgb;
  }

  updateLocalWhiteValues(_whiteValues){
    this.lightState.whiteValues = _whiteValues;
  }

  updateLocalIsOn(_isOn){
    this.lightState.isOn = _isOn;
  }

  updateLocalBrightness(_brightness){
    this.lightState.brightness = _brightness;
  }


  /**
   ** @updateDeviceState
   *  determine RGB and warmWhite/coldWhite values  from homekit's HSL
   *  perform different logic based on light's capabilities, detimined by "this.accessory.context.lightVersion"
   *  
   */
  async updateDeviceState(_timeout = 200) {


    //**** local variables ****\\
    const hsl = this.lightState.HSL;
    const [red, green, blue] = convertHSLtoRGB(hsl); //convert HSL to RGB
    const brightness = this.lightState.brightness;
    /*
    this.platform.log.debug('Current HSL and Brightness: h:%o s:%o l:%o br:%o', hsl.hue, hsl.saturation, hsl.luminance, brightness);
    this.platform.log.debug('Converted RGB: r:%o g:%o b:%o', red, green, blue);
    */
    const mask = 0xF0; // the 'mask' byte tells the controller which LEDs to turn on color(0xF0), white (0x0F), or both (0xFF)
    //we default the mask to turn on color. Other values can still be set, they just wont turn on
    
    //sanitize our color/white values with Math.round and clamp between 0 and 255, not sure if either is needed
    //next determine brightness by dividing by 100 and multiplying it back in as brightness (0-100)
    const r = Math.round(((clamp(red, 0, 255) / 100) * brightness));
    const g = Math.round(((clamp(green, 0, 255) / 100) * brightness));
    const b = Math.round(((clamp(blue, 0, 255) / 100) * brightness));

    await this.send([0x31, r, g, b, 0x00, mask, 0x0F], true, _timeout); //8th byte checksum calculated later in send()
  


  }//updateDeviceState

  //=================================================
  // End State Get/Set //

  //=================================================
  // Start Misc Tools //


  /**
   ** @calculateWhiteColor
   *  determine warmWhite/coldWhite values from hue
   *  the closer to 0/360 the weaker coldWhite brightness becomes
   *  the closer to 180 the weaker warmWhite brightness becomes
   *  the closer to 90/270 the stronger both warmWhite and coldWhite become simultaniously
   */
  hueToWhiteTemperature() {
    const hsl = this.lightState.HSL;
    let multiplier = 0;
    const whiteTemperature = { warmWhite: 0, coldWhite: 0 };


    if (hsl.hue <= 90) {        //if hue is <= 90, warmWhite value is full and we determine the coldWhite value based on Hue
      whiteTemperature.warmWhite = 255;
      multiplier = ((hsl.hue / 90));
      whiteTemperature.coldWhite = Math.round((255 * multiplier));
    } else if (hsl.hue > 270) { //if hue is >270, warmWhite value is full and we determine the coldWhite value based on Hue
      whiteTemperature.warmWhite = 255;
      multiplier = (1 - (hsl.hue - 270) / 90);
      whiteTemperature.coldWhite = Math.round((255 * multiplier));
    } else if (hsl.hue > 180 && hsl.hue <= 270) { //if hue is > 180 and <= 270, coldWhite value is full and we determine the warmWhite value based on Hue
      whiteTemperature.coldWhite = 255;
      multiplier = ((hsl.hue - 180) / 90);
      whiteTemperature.warmWhite = Math.round((255 * multiplier));
    } else if (hsl.hue > 90 && hsl.hue <= 180) {//if hue is > 90 and <= 180, coldWhite value is full and we determine the warmWhite value based on Hue
      whiteTemperature.coldWhite = 255;
      multiplier = (1 - (hsl.hue - 90) / 90);
      whiteTemperature.warmWhite = Math.round((255 * multiplier));
    }
    return whiteTemperature;
  } //hueToWhiteTemperature

  


  async send(command: number[], useChecksum = true, _timeout = 200) {
    const buffer = Buffer.from(command);

    const output = await this.transport.send(buffer, useChecksum, _timeout);
    //this.platform.log.debug('Recieved the following response', output);

  } //send

  cacheCurrentLightState(){
    this.lightStateTemporary.HSL = this.lightState.HSL;
  }

  async restoreCachedLightState(){
    this.lightState.HSL = this.lightStateTemporary.HSL;
    await this.updateDeviceState();
  }
  //=================================================
  // End Misc Tools //


  //=================================================
  // Start LightEffects //

  flashEffect() {
    this.lightState.HSL.hue = 100 as number;
    this.lightState.HSL.saturation = 100 as number;

    let change = true;
    let count = 0;

    const interval = setInterval( async () => {

      if (change) {
        this.lightState.brightness = 0;

      } else {
        this.lightState.brightness = 100;
      }

      change = !change;
      count++;
      await this.updateDeviceState();

      if (count >= 20) {

        this.lightState.HSL.hue = 0;
        this.lightState.HSL.saturation = 5;
        this.lightState.brightness = 100;
        await this.updateDeviceState();
        clearInterval(interval);
        return;
      }
    }, 300);
  } //flashEffect
  
  async stopAnimation(){
    this.activeAnimation = animations.none;
    // this.service2.updateCharacteristic(this.platform.Characteristic.On, false);
    //clearInterval(this.interval);
  }

  /*
  async rainbowEffect(value: CharacteristicValue, callback: CharacteristicSetCallback) {
    const isOn = value as boolean;
    if(!isOn){
      this.stopAnimation();
    }else{ 
      let hue = 0;
      const increment = 10;
      const waitTime = 0;
      let wait = waitTime;
      const isWaiting = false;
      
      this.interval = setInterval(() => {
        this.lightState.HSL.saturation = 100 as number;
        this.lightState.HSL.hue = hue as number;
        this.service.updateCharacteristic(this.platform.Characteristic.Hue, hue);

        if(wait > 0 && hue % (360/increment)){
          wait --;
        } else {
          wait = waitTime;
          hue += increment;
        }
        
        this.updateDeviceState(10);

        if(hue>359){
          hue = 0;
        }

      }, 125);
     
    }
    callback(null);
  } //rainbowEffect
*/


  //=================================================
  // End LightEffects //


  speedToDelay(speed: number) {
    speed = clamp(speed, 0, 100);
    return (30 - ((speed / 100) * 30)) + 1;
  }

  /**
	 * Sets the controller to display one of the predefined patterns
	 * @param {String} pattern Name of the pattern
	 * @param {Number} speed between 0 and 100
	 * @param {function} callback 
	 * @returns {Promise<boolean>}
	 */
  setPattern(pattern: number, speed: number) {

    const delay = this.speedToDelay(speed);

    //const cmd_buf = Buffer.from();

    //const promise = new Promise((resolve, reject) => {
    this.send([0x61, pattern, delay, 0x0f]);
    //}).then(data => {
    //return (data.length > 0 || !this._options.ack.pattern); 
    //});

    // if (callback && typeof callback == 'function') {
    // promise.then(callback.bind(null, null), callback);
    //}

    //return promise;
  }

  
} // ZackneticMagichomePlatformAccessory class

