const { EufySecurity, Device, CommandName } = require("eufy-security-client");
const config = require("./data/config.json");
const { Logger } = require("tslog");
const ffmpeg = require("fluent-ffmpeg");
const { StreamInput } = require("fluent-ffmpeg-multistream");
const express = require("express");
const app = express();

const port = 3000;

/**
 * @type EufySecurity | undefined
 */
let eufy;

/**
 * @type Map<string, ffmpeg.FfmpedCommand>
 */
const streams = new Map();

let cleaningUp = false;

async function main() {
  const logger = new Logger({
    // https://tslog.js.org/#/?id=minlevel
    // minLevel: 4, // warning
    minLevel: 2,
  });

  const updatedConfig = {
    persistentDir: process.cwd() + "/data",
    ...config,
  };

  eufy = await EufySecurity.initialize(updatedConfig, logger);

  eufy.on("connection error", (error) => {
    console.error(error);
    cleaningUp();
  });

  eufy.on("connect", async () => {
    console.log("Connected");

    const stations = await eufy.getStations();
    const cameras = stations.filter((station) =>
      Device.isCamera(station.getDeviceType())
    );

    console.log(`Found ${stations.length} stations`);

    const p2pCameras = [];

    for (const camera of cameras) {
      const device = await eufy.getDevice(camera.getSerial());

      if (device.hasCommand(CommandName.DeviceStartLivestream)) {
        p2pCameras.push({
          camera,
          device,
        });
      }
    }

    console.log(`Found ${p2pCameras.length} P2P cameras`);

    // Only working with one camera for now, but we could probably scale it up
    const [{ camera, device }] = p2pCameras;

    // await eufy.startStationLivestream(camera.getSerial());
    await camera.startLivestream(device);
  });

  eufy.on(
    "station livestream start",
    (station, device, metadata, videostream, audiostream) => {
      const serial = station.getSerial();

      if (streams.has(serial)) {
        return;
      }

      const output = `rtsp://192.168.1.115:8554/${serial}-2`;

      try {
        const command = ffmpeg()
          .videoCodec("libx264")
          .input(StreamInput(videostream).url)
          .noAudio()
          .output(output)
          .outputOptions([
            "-c copy",
            "-f rtsp",
            "-rtsp_transport tcp",
            `-analyzeduration ${1.2}`,
            "-hls_init_time 0",
            "-hls_time 1",
            "-hls_segment_type mpegts",
            "-hls_playlist_type event",
            "-hls_list_size 0",
            "-preset ultrafast",
            "-tune zerolatency",
            "-g 15",
            "-sc_threshold 0",
            "-fflags genpts+nobuffer+flush_packets",
          ]);

        streams.set(serial, command);

        command
          .on("error", (error) => {
            console.error(error);
            cleanup();
          })
          .run();

        console.log(`Proxying the camera ${serial} to ${output}...`);
      } catch (error) {
        console.error(error);
        cleanup();
      }
    }
  );

  eufy.on("station livestream stop", async (station) => {
    const serial = station.getSerial();

    if (!streams.has(serial)) {
      return;
    }

    streams.get(serial).kill("SIGKILL");
  });

  eufy.on("captcha request", (id, captcha) => {
    const base64ViewerUrl =
      "https://www.rapidtables.com/web/tools/base64-to-image.html";
    console.warn(
      `A captcha is required, please go over ${base64ViewerUrl} and enter the Base64 string bellow\n${captcha}\n\nOnce completed, please fill provide the code using: http://127.0.0.1:${port}/verify/${id}/<code>`
    );
  });

  await eufy.connect();
  console.log("Connecting...");
}

function cleanup() {
  cleaningUp = true;

  if (eufy) {
    eufy.close();
  }

  process.exit();
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

main().catch((error) => {
  console.error(error);
  cleanup();
});

app.get("/verify/:id/:code", async (req, res) => {
  console.log("FSDDSFD", req.params);

  await eufy.connect({
    captcha: {
      captchaId: req.params.id,
      captchaCode: req.params.code,
    },
  });

  res.send("Connected");
});

app.listen(3000, () => {
  console.log(`Example app listening on port ${3000}`);
});
