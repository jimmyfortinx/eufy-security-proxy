const { EufySecurity, Device, CommandName } = require("eufy-security-client");
const config = require("../data/config.json");
const { Logger } = require("tslog");
const ffmpeg = require("fluent-ffmpeg");
const net = require("net");
const { captchas, getVerificationUrl, verification } = require("./express");

/**
 * @type EufySecurity | undefined
 */
let eufy;

/**
 * @type Map<string, ffmpeg.FfmpedCommand>
 */
const streams = new Map();

async function main() {
  const logger = new Logger({
    // https://tslog.js.org/#/?id=minlevel
    minLevel: process.env.LOG_LEVEL || 4, // warning
  });

  const updatedConfig = {
    persistentDir: process.cwd() + "/data",
    ...config,
  };

  eufy = await EufySecurity.initialize(updatedConfig, logger);

  eufy.on("connection error", (error) => {
    console.error(error);
    cleanUp();
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

    await camera.startLivestream(device);
  });

  eufy.on(
    "station livestream start",
    (station, _device, _metadata, videostream, audiostream) => {
      const serial = station.getSerial();

      if (streams.has(serial)) {
        return;
      }

      const output = `rtsp://${
        process.RTSP_HOSTNAME || config.rtsp?.hostname || "easydarwin"
      }:${process.RTSP_PORT || config.rtsp?.port || "554"}/${serial}`;

      try {
        const command = ffmpeg();

        if (!process.DISABLE_VIDEO) {
          const port = 8888;
          net
            .createServer((socket) =>
              videostream.on("data", (chunk) => socket.write(chunk))
            )
            .listen(port);
          command.videoCodec("copy").input(`tcp://localhost:${port}`);
        }

        if (!process.DISABLE_AUDIO) {
          const port = 8889;
          net
            .createServer((socket) =>
              audiostream.on("data", (chunk) => socket.write(chunk))
            )
            .listen(port);
          command.audioCodec("aac").input(`tcp://localhost:${port}`);
        }

        command
          .output(output)
          .outputOptions([
            "-f rtsp",
            "-rtsp_transport tcp",
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
            "-loglevel debug",
          ]);

        if (process.LOG_FFMPEG) {
          command.on("stderr", function (stderrLine) {
            console.log("Stderr output: " + stderrLine);
          });
        }

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
    captchas.set(id, captcha);

    console.warn(
      `A captcha is required, please go over ${getVerificationUrl(
        id
      )} to complete the authentication process.`
    );
  });

  verification.on("code_received", async ({ id, code }) => {
    await eufy.connect({
      captcha: {
        captchaId: id,
        captchaCode: code,
      },
    });
  });

  await eufy.connect();
  console.log("Connecting...");
}

function cleanup() {
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
