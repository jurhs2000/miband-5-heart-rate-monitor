import { ADVERTISEMENT_SERVICE, CHAR_UUIDS, UUIDS } from "./constants.js";

function buf2hex(buffer) {
  return Array.prototype.map
    .call(new Uint8Array(buffer), (x) => ("00" + x.toString(16)).slice(-2))
    .join("");
}

const concatBuffers = (buffer1, buffer2) => {
  const out = new Uint8Array(buffer1.byteLength + buffer2.byteLength);
  out.set(new Uint8Array(buffer1), 0);
  out.set(new Uint8Array(buffer2), buffer1.byteLength);
  return out.buffer;
};

export class MiBand5 {
  /**
   * @param {String} authKey
   *   Hex representation of the auth key (https://github.com/Freeyourgadget/Gadgetbridge/wiki/Huami-Server-Pairing)
   *   Example: '94359d5b8b092e1286a43cfb62ee7923'
   */
  constructor(authKey) {
    if (!authKey.match(/^[a-zA-Z0-9]{32}$/)) {
      throw new Error(
        "Invalid auth key, must be 32 hex characters such as '94359d5b8b092e1286a43cfb62ee7923'"
      );
    }
    this.authKey = authKey;
    this.services = {};
    this.chars = {};
  }

  async init() {
    const device = await navigator.bluetooth.requestDevice({
      filters: [
        {
          services: [ADVERTISEMENT_SERVICE],
        },
      ],
      optionalServices: [UUIDS.miband2, UUIDS.heartrate, UUIDS.miband1],
    });
    window.dispatchEvent(new CustomEvent("connected"));
    await device.gatt.disconnect();
    const server = await device.gatt.connect();
    console.log("Connected through gatt");

    this.services.miband1 = await server.getPrimaryService(UUIDS.miband1);
    this.services.miband2 = await server.getPrimaryService(UUIDS.miband2);
    this.services.heartrate = await server.getPrimaryService(UUIDS.heartrate);
    console.log("Services initialized");

    this.chars.auth = await this.services.miband2.getCharacteristic(
      CHAR_UUIDS.auth
    );
    this.chars.hrControl = await this.services.heartrate.getCharacteristic(
      CHAR_UUIDS.heartrate_control
    );
    this.chars.hrMeasure = await this.services.heartrate.getCharacteristic(
      CHAR_UUIDS.heartrate_measure
    );
    this.chars.sensor = await this.services.miband1.getCharacteristic(
      CHAR_UUIDS.sensor
    );
    console.log("Characteristics initialized");
    await this.authenticate();
  }

  async authenticate() {
    await this.startNotifications(this.chars.auth, async (e) => {
      const value = e.target.value.buffer;
      const cmd = buf2hex(value.slice(0, 3));
      if (cmd === "100101") {
        console.log("Set new key OK");
      } else if (cmd === "100201") {
        const number = value.slice(3);
        console.log(
          "Received authentication challenge: ",
          buf2hex(value.slice(3))
        );
        const key = aesjs.utils.hex.toBytes(this.authKey);
        const aesCbc = new aesjs.ModeOfOperation.cbc(key);
        const out = aesCbc.encrypt(new Uint8Array(number));
        const cmd = concatBuffers(new Uint8Array([3, 0]), out);
        console.log("Sending authentication response");
        await this.chars.auth.writeValue(cmd);
      } else if (cmd === "100301") {
        await this.onAuthenticated();
      } else if (cmd === "100308") {
        console.log("Received authentication failure");
      } else {
        throw new Error(`Unknown callback, cmd='${cmd}'`);
      }
    });
    await this.chars.auth.writeValue(Uint8Array.from([2, 0]));
  }

  async onAuthenticated() {
    console.log("Authentication successful");
    window.dispatchEvent(new CustomEvent("authenticated"));
    await this.measureHr();
  }

  async measureHr() {
    // Conectar con el servidor
    const socket = new WebSocket("ws://127.0.0.1:2222");
    let lastHeartRateTime = Date.now(); // Tiempo de la última recepción de datos del ritmo cardíaco
    const PING_INTERVAL = 30000; // segundos entre pings

    socket.onopen = async () => {
      console.log("Conectado al servidor");

      await this.chars.hrControl.writeValue(
        Uint8Array.from([0x15, 0x02, 0x00])
      );
      await this.chars.hrControl.writeValue(
        Uint8Array.from([0x15, 0x01, 0x00])
      );

      await this.startNotifications(this.chars.hrMeasure, async (e) => {
        console.log("Received heart rate value: ", e.target.value);

        // Actualizar el tiempo de la última recepción de datos
        lastHeartRateTime = Date.now();

        // Enviar un mensaje al servidor
        const sensor_data = {
          dateTime: new Date().toISOString(),
          bpm: e.target.value.getInt16(),
        };
        const json_string = JSON.stringify(sensor_data);
        console.log(json_string);
        socket.send(json_string);

        const heartRate = e.target.value.getInt16();
        window.dispatchEvent(
          new CustomEvent("heartrate", {
            detail: heartRate,
          })
        );
      });

      await this.chars.hrControl.writeValue(
        Uint8Array.from([0x15, 0x01, 0x01])
      );

      // Ping WebSocket cada PING_INTERVAL milisegundos
      this.pingInterval = setInterval(() => {
        const timeSinceLastHeartRate = Date.now() - lastHeartRateTime;
        
        // Si no se ha recibido un dato en más de 30 segundos
        if (timeSinceLastHeartRate > 30000) {
            console.warn("No se ha recibido el ritmo cardíaco en más de 30 segundos. Reiniciando...");
            socket.send(JSON.stringify({ type: 'ping' })); // Enviar un mensaje de ping al servidor
            
            // Reiniciar la medición
            this.chars.hrControl.writeValue(Uint8Array.from([0x15, 0x01, 0x01]));
        } else {
            console.log("Enviando ping...");
            socket.send(JSON.stringify({ type: 'ping' })); // Enviar un ping regular
        }
      }, PING_INTERVAL);

      socket.onmessage = function (event) {
        // Assuming the server is sending a JSON message
        console.log("Mensaje recibido del servidor solo event:", event);
        console.log("Mensaje recibido del servidor:", event.data);
        const data = JSON.parse(event.data);
        let state = '';
        if (data.sleepStage == 0) {
          state = "Despierto";
        } else if (data.sleepStage == 1) {
          state = "Sueño ligero";
        } else if (data.sleepStage == 2) {
          state = "Sueño profundo";
        }
        console.warn(`Se detectó somnolencia!\nEstado: ${state} - Fecha y hora: ${(new Date()).toLocaleString()}`);
        window.dispatchEvent(
          new CustomEvent("alert", {
            detail: data.sleepStage === 0 ? "Estado: Despierto" : "Se detectó somnolencia!\nEstado: " + state,
          })
        );
      };
    };

    socket.onclose = function () {
      console.log("Conexión WebSocket cerrada");
    };

    socket.onerror = function (error) {
      console.error("Error en WebSocket:", error);
    };
  }

  async startNotifications(char, cb) {
    await char.startNotifications();
    char.addEventListener("characteristicvaluechanged", cb);
  }
}

window.MiBand5 = MiBand5;
