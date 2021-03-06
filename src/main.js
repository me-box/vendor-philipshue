/*jshint esversion: 6 */
const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const databox = require('node-databox');
const fs = require('fs');

const DATABOX_ARBITER_ENDPOINT = process.env.DATABOX_ARBITER_ENDPOINT || "tcp://127.0.0.1:4444"
const DATABOX_ZMQ_ENDPOINT = process.env.DATABOX_ZMQ_ENDPOINT || "tcp://127.0.0.1:5555";
const DATABOX_TESTING = !(process.env.DATABOX_VERSION);
const PORT = process.env.port || '8080';

let basePath = ""
if (!DATABOX_TESTING) {
  basePath = "/driver-phillips-hue"
}

const store = databox.NewStoreClient(DATABOX_ZMQ_ENDPOINT, DATABOX_ARBITER_ENDPOINT)

const settingsManager = require('./settings.js')(store);
const hue = require('./hue/hue.js')(settingsManager);


const app = express();

const https = require('https');
const http = require('http');

//some nasty global vars to holds the current state
var registeredLights = {} //keep track of which lights have been registered as data sources
var registeredSensors = {} //keep track of which sensors have been registered as data sources
var vendor = "Philips Hue";


app.set("configured", false)


// app setup
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));


app.get('/status', function (req, res, next) {
  if (app.settings.configured) {
    res.send("active");
  } else {
    res.send("requiresConfig");
  }
});

app.get('/ui', function (req, res, next) {
  if (app.settings.configured) {
    let bulbList = []
    let lights = Object.entries(registeredLights)
    if (lights.length > 0) {
      bulbList = lights.map((bulb) => {
        return "<li><b>" + bulb[1].name + "</b> Last value: <pre>" + JSON.stringify(bulb[1].state, null, 3) + "</pre></li>"
      });
    } else {
      bulbList = ["<li>No bulbs found!</li>"]
    }
    let sensorsList = []
    let sensors = Object.entries(registeredSensors)
    if (sensors.length > 0) {
      sensorsList = sensors.map((s) => {
        return "<li><b>" + s[1].name + "(" + s[1].type + ")</b> Last value: <pre>" + JSON.stringify(s[1].state, null, 3) + "</pre></li>"
      });
    } else {
      sensorsList = ["<li>No sensors found!</li>"]
    }

    res.send(
      `<img style="float:right; margin: 10px" src="https://developers.meethue.com/wp-content/themes/hue_developer_theme/img/site_logo.png" />` +
      "<h1 style='clear:both'>Lights</h1><div id='bulbs'><ul>" + bulbList.concat(" \n") + "</ul></div>" +
      "<h1>Sensors</h1><div id='sensors'><ul>" + sensorsList.concat(" \n") + "</ul></div>" +
      `
      <script type="text/javascript">
          setInterval('window.location.reload()', 5000);
      </script>
      `
    );
  } else {
    res.send(
      `
      <html>
      <body style="width:100%">
      <div style="position: absolute; width:70%; max-width:600px; top: 50%; left: 50%; transform: translate(-50%, -50%)">
        <img style="float:right" src="https://developers.meethue.com/wp-content/themes/hue_developer_theme/img/site_logo.png" />
        <h1>Pair your Philips hue bridge</h1>
        <h3>Enter IP below, then press button on bridge, then click Pair bridge</h3>
        <form method="post" action="`+ basePath + `/ui/configure">
          Enter bridge IP address: <input type="text" value="" name="bridge_ip" />
          <input type="submit", value="Pair bridge" />
        </form>
      </div>
      </body>
      `
    )
  }
});

app.post('/ui/configure', function (req, res) {
  var ip_address = (req.body.bridge_ip);

  console.log(req.body.bridge_ip);

  hue.findHub(ip_address)
    .then((data) => {
      app.set("configured", true)
      res.redirect(302, "/ui")
    })
    .catch((err) => {
      res.status(401).send("Failed to find hue bridge at " + ip_address + "<b>" + err + "</b>");
    });

});

//when testing, we run as http, (to prevent the need for self-signed certs etc);
if (DATABOX_TESTING) {
  console.log("[Creating TEST http server]", PORT);
  server = http.createServer(app).listen(PORT);

} else {
  console.log("[Creating https server]", PORT);
  const credentials = databox.GetHttpsCredentials();
  server = https.createServer(credentials, app).listen(PORT);
}

module.exports = app;

const HueApi = require("node-hue-api").HueApi;

//wait until we have a valid config from the store or user then call startDriverWork
waitForConfig()

//Set up observation to deal with actuation events
async function ObserveProperty(dsID) {

  console.log("[Observing] ", dsID);
  try {
    const actuationEmitter = await store.TSBlob.Observe(dsID)

    actuationEmitter.on('data', (JsonObserveResponse) => {
      console.log("[Actuation] data received", dsID, JsonObserveResponse.data);
      const tmp = dsID.split('-');
      const hueType = tmp[2];
      const hueId = tmp[3];
      _data = JSON.parse(JsonObserveResponse.data);
      hue.setLights(hueId, hueType, _data.data);
    });

    actuationEmitter.on('error', (JsonObserveResponse) => {
      console.warn("[Observation Error]", dsID, err);
    });

  } catch (err) {
    console.warn("[Error Observing] ", dsID, err);
  }

}

async function waitForConfig() {

  await store.RegisterDatasource({
    Description: 'Philips hue driver settings',
    ContentType: 'text/json',
    Vendor: 'Databox Inc.',
    DataSourceType: 'philipsHueSettings',
    DataSourceID: 'philipsHueSettings',
    StoreType: 'kv',
  });

  let settings = await settingsManager.getSettings()
    .catch((err) => {
      console.log("[waitForConfig] waiting for user configuration. ", err);
    })

  if (typeof settings == 'undefined') {
    //we have no settings wait 5 seconds and try again
    setTimeout(waitForConfig, 5000)
    return
  }

  app.set("configured", true)

  startDriverWork(settings)
}

//deal with sensors
function formatID(id) {
  return id.replace(/\W+/g, "").trim();
}

async function startDriverWork(settings) {

  let hueApi = new HueApi(settings.hostname, settings.hash)

  let lights = {}
  lights = await hueApi.lights()
    .catch((err) => {
      console.log("[Error] getting light data", err);
    })

  if (typeof (lights) == "undefined") {
    lights = { "lights": [] }
  }
  processlights(lights)

  let sensors = {}
  sensors = await hueApi.sensors()
    .catch((err) => {
      console.log("[Error] getting sensor data", err);
    })
  if (typeof (sensors) == "undefined") {
    sensors = { "sensors": [] }
  }
  processSensors(sensors)

  //setup next poll
  console.log("setting up next poll")
  setTimeout(startDriverWork, 3000, settings);

}


async function wait(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

async function processSensors(sensors) {

  //filter out sensors without an id
  let validSensors = sensors.sensors.filter((itm) => { return itm.uniqueid })

  for (let i = 0; i < validSensors.length; i++) {

    let sensor = validSensors[i]

    if (!(sensor.uniqueid in registeredSensors)) {
      //new light found
      console.log("[NEW SENSOR FOUND] " + formatID(sensor.uniqueid) + " " + sensor.type + " " + sensor.name);

      //register data sources
      await store.RegisterDatasource({
        Description: sensor.name + sensor.type,
        ContentType: 'text/json',
        Vendor: vendor,
        DataSourceType: 'hue-' + sensor.type,
        DataSourceID: 'hue-' + formatID(sensor.uniqueid),
        StoreType: 'ts'
      })
        .catch((error) => {
          console.log("[ERROR] register sensor", error);
        });
    }

    registeredSensors[sensor.uniqueid] = sensor;

    console.log("writing sensor data ", i);
    await writeWithTimeOut('hue-' + formatID(sensor.uniqueid), sensor.state)
      .catch((error) => {
        console.log("[ERROR] writing sensor data", error);
      });

  }
}

async function processlights(lights) {

  for (let i = 0; i < lights.lights.length; i++) {

    let light = lights.lights[i]
    let lightID = light.id

    if (!(light.uniqueid in registeredLights)) {
      //new light found
      console.log("[NEW BULB FOUND] " + light.uniqueid + " " + light.name + " lightID=" + lightID);

      //register data sources
      await store.RegisterDatasource({
        Description: light.name + ' on off state.',
        ContentType: 'text/json',
        Vendor: vendor,
        DataSourceType: 'bulb-on',
        DataSourceID: 'bulb-on-' + lightID,
        StoreType: 'ts/blob'
      })

      await store.RegisterDatasource({
        Description: light.name + ' hue value.',
        ContentType: 'text/json',
        Vendor: vendor,
        DataSourceType: 'bulb-hue',
        DataSourceID: 'bulb-hue-' + lightID,
        StoreType: 'ts/blob'
      });

      await store.RegisterDatasource({
        Description: light.name + ' brightness value.',
        ContentType: 'text/json',
        Vendor: vendor,
        DataSourceType: 'bulb-bri',
        DataSourceID: 'bulb-bri-' + lightID,
        StoreType: 'ts/blob'
      });

      await store.RegisterDatasource({
        Description: light.name + ' saturation value.',
        ContentType: 'text/json',
        Vendor: vendor,
        DataSourceType: 'bulb-sat',
        DataSourceID: 'bulb-sat-' + lightID,
        StoreType: 'ts/blob'
      });

      await store.RegisterDatasource({
        Description: light.name + ' color temperature value.',
        ContentType: 'text/json',
        Vendor: vendor,
        DataSourceType: 'bulb-ct',
        DataSourceID: 'bulb-ct-' + lightID,
        StoreType: 'ts/blob'
      });

      await store.RegisterDatasource({
        Description: 'Set ' + light.name + ' bulbs on off state.',
        ContentType: 'text/json',
        Vendor: vendor,
        DataSourceType: 'set-bulb-on',
        DataSourceID: 'set-bulb-on-' + lightID,
        StoreType: 'ts/blob',
        IsActuator: true
      })

      //set up the listeners for observe events
      ObserveProperty('set-bulb-on-' + lightID)
      ObserveProperty('set-bulb-hue-' + lightID)
      ObserveProperty('set-bulb-ct-' + lightID)
      ObserveProperty('set-bulb-sat-' + lightID)
      ObserveProperty('set-bulb-bri-' + lightID)
    }

    //build the current state for the UI
    registeredLights[light.uniqueid] = light;

    //Update bulb state
    console.log("Updating light state", { data: light.state.on })
    writeWithTimeOut('bulb-on-' + lightID, { data: light.state.on })
    .catch((err) => {
      console.log("[Error] could not write light data. ", err);
    })

    console.log("Updating light 2")
    writeWithTimeOut('bulb-hue-' + lightID, { data: light.state.hue })
    .catch((err) => {
      console.log("[Error] could not write light data. ", err);
    })

    console.log("Updating light 3")
    writeWithTimeOut('bulb-bri-' + lightID, { data: light.state.bri })
    .catch((err) => {
      console.log("[Error] could not write light data. ", err);
    })

    console.log("Updating light 4")
    writeWithTimeOut('bulb-sat-' + lightID, { data: light.state.sat })
    .catch((err) => {
      console.log("[Error] could not write light data. ", err);
    })

    console.log("Updating light 5")
    writeWithTimeOut('bulb-ct-' + lightID, { data: light.state.ct })
    .catch((err) => {
      console.log("[Error] could not write light data. ", err);
    })

  } //end bulb processing
}

async function writeWithTimeOut(dsid, data) {
  return new Promise(async (resolve) => {
    let cancelled = false
    setTimeout(function () { cancelled = true; resolve(); }, 1000)
    await store.TSBlob.Write(dsid, data)
    if (!cancelled) {
      resolve()
    }
  })
}