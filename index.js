const { EufySecurity, Device, CommandName } = require("eufy-security-client");
const config = require("./config.json");
const { Logger } = require("tslog");
const net = require("net");
const ffmpeg = require("fluent-ffmpeg");

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
    minLevel: 4, // warning
  });

  eufy = await EufySecurity.initialize(config, logger);

  await eufy.connect();

  eufy.on("connect", async () => {
    const stations = await eufy.getStations();
    const cameras = stations.filter((station) =>
      Device.isCamera(station.getDeviceType())
    );

    console.log(`Connected and found ${stations.length} stations`);

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

      net
        .createServer(function (socket) {
          videostream.on("readable", () => {
            let chunk;

            while (null !== (chunk = videostream.read())) {
              socket.write(chunk);
            }
          });
        })
        .listen(8956, "127.0.0.1");

      const inputVideo = `tcp://127.0.0.1:8956`;
      const output = `rtsp://192.168.1.115:8554/${serial}`;

      try {
        const command = ffmpeg()
          .videoCodec("libx264")
          .input(inputVideo)
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
