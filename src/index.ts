import "./dotenv.ts";
import {
  EufySecurity,
  Device,
  CommandName,
  type EufySecurityConfig,
  type Station,
  P2PConnectionType,
  type P2PClientProtocol,
  LogLevel,
} from "eufy-security-client";
import { Logger } from "tslog";
import ffmpeg from "fluent-ffmpeg";
import net, { Server, Socket } from "net";
import { captchas, getVerificationUrl, verification } from "./express.ts";
import { flushAndExit, winstonLogger } from "./logger.ts";
import { setLoggingLevel } from "eufy-security-client/build/logging.js";

const MAX_RETRY_ATTEMPTS = 3;
let retryAttempt = 0;
let eufy: EufySecurity | undefined;

async function cleanup() {
  if (eufy !== undefined) {
    try {
      eufy.close();
    } catch (error) {
      console.error("An error happened while closing eufy connections", error);
    }
  }

  await flushAndExit();
}

function logErrorAndExit(message: string) {
  return async (error: any) => {
    winstonLogger.error(message, error);
    await cleanup();
  };
}

/**
 * @type Map<string, ffmpeg.FfmpedCommand>
 */
const streams = new Map<
  string,
  {
    command: ffmpeg.FfmpegCommand;
    video: Server | undefined;
    audio: Server | undefined;
  }
>();

let timeoutId: NodeJS.Timeout | undefined = undefined;

async function main() {
  const logger = new Logger({
    argumentsArrayName: "argumentsArray",
    attachedTransports: [
      (logObject) => {
        {
          const [first, ...meta] =
            (logObject.argumentsArray as any as any[]) ?? [""];

          return winstonLogger.log(
            logObject._meta.logLevelName.toLowerCase(),
            typeof first === "string" ? first : JSON.stringify(first),
            ...meta
          );
        }
      },
    ],
  });

  if (process.env.USERNAME === undefined) {
    throw new Error("USERNAME environment variable is missing");
  }

  if (process.env.PASSWORD === undefined) {
    throw new Error("PASSWORD environment variable is missing");
  }

  const updatedConfig: EufySecurityConfig = {
    persistentDir: process.cwd() + "/data",
    username: process.env.USERNAME,
    password: process.env.PASSWORD,
    p2pConnectionSetup: P2PConnectionType.QUICKEST,
    pollingIntervalMinutes: 10,
    eventDurationSeconds: 10,
    enableEmbeddedPKCS1Support: true,
  };

  eufy = await EufySecurity.initialize(updatedConfig, logger);

  eufy.on("connection error", logErrorAndExit("connection error"));

  const stop = async (stationSerial: string) => {
    const stream = streams.get(stationSerial);

    if (stream === undefined) {
      return;
    }

    const { command, audio, video } = stream;

    audio?.close();
    video?.close();
    command.kill("SIGKILL");
    streams.delete(stationSerial);
  };

  const start = async (stopLivestream?: boolean) => {
    if (eufy === undefined) {
      throw new Error("Undefined");
    }

    if (retryAttempt > MAX_RETRY_ATTEMPTS) {
      eufy.setLoggingLevel("all", LogLevel.Debug);
    }

    try {
      const stations = await eufy.getStations();
      const cameras = stations.filter((station) =>
        Device.isCamera(station.getDeviceType())
      );

      winstonLogger.info(`Found ${stations.length} stations`);

      const p2pCameras: { camera: Station; device: Device }[] = [];

      for (const camera of cameras) {
        const device = await eufy.getDevice(camera.getSerial());

        if (device.hasCommand(CommandName.DeviceStartLivestream)) {
          p2pCameras.push({
            camera,
            device,
          });
        }
      }

      winstonLogger.info(`Found ${p2pCameras.length} P2P cameras`);

      timeoutId = setTimeout(() => {
        winstonLogger.error(
          "Could not start the livestream inside of 30 seconds"
        );
        cleanup();
      }, 30000);

      // Only working with one camera for now, but we could probably scale it up
      const [{ camera, device }] = p2pCameras;

      if (stopLivestream) {
        winstonLogger.info("stopping livestream");
        await stop(device.getStationSerial());
      }
      await camera.startLivestream(device);
    } catch (error) {
      await logErrorAndExit("livestream start error")(error);
    }
  };

  const restart = (context: string) => async (error: any) => {
    if (retryAttempt > MAX_RETRY_ATTEMPTS) {
      await logErrorAndExit(context)(error);
    } else {
      retryAttempt++;
      winstonLogger.warn(
        `${context}, we will retry (${retryAttempt}/${MAX_RETRY_ATTEMPTS})`
      );
      await start(true);
    }
  };

  (eufy as any as P2PClientProtocol).on(
    "livestream error",
    async (_, error) => {
      await restart("livestream error")(error);
    }
  );

  eufy.on("connect", async () => {
    winstonLogger.info("Connected");

    await start();
  });

  eufy.on(
    "station livestream start",
    (station, _device, _metadata, videostream, audiostream) => {
      const serial = station.getSerial();

      if (streams.has(serial)) {
        return;
      }

      const output = `rtsp://${process.env.RTSP_HOSTNAME || "easydarwin"}:${
        process.env.RTSP_PORT || "554"
      }/${serial}`;

      try {
        const command = ffmpeg();
        let video: Server | undefined;
        let audio: Server | undefined;

        if (!process.env.DISABLE_VIDEO) {
          const port = 8888;
          video = net
            .createServer((socket) =>
              videostream.on("data", (chunk) => socket.write(chunk))
            )
            .listen(port);
          command.videoCodec("copy").input(`tcp://localhost:${port}`);
        }

        if (!process.env.DISABLE_AUDIO) {
          const port = 8889;
          audio = net
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
            ...(process.env.LOG_FFMPEG ? ["-loglevel debug"] : []),
          ]);

        if (process.env.LOG_FFMPEG) {
          command.on("stderr", function (stderrLine) {
            winstonLogger.info(stderrLine, {
              source: "ffmpeg",
            });
          });
        }

        streams.set(serial, { command, audio, video });

        command
          .on("error", async (error) => logErrorAndExit("ffmpeg command error"))
          .run();

        clearTimeout(timeoutId);
        retryAttempt = 0;
        setLoggingLevel("all", LogLevel.Off);

        winstonLogger.info(`Proxying the camera ${serial} to ${output}...`);
      } catch (error) {
        winstonLogger.error(error);
        cleanup();
      }
    }
  );

  eufy.on("station livestream stop", (station) => stop(station.getSerial()));

  eufy.on("captcha request", (id, captcha) => {
    captchas.set(id, captcha);

    winstonLogger.warn(
      `A captcha is required, please go over ${getVerificationUrl(
        id
      )} to complete the authentication process.`
    );
  });

  verification.on("code_received", async ({ id, code }) => {
    if (eufy === undefined) {
      throw new Error("Undefined");
    }

    await eufy.connect({
      captcha: {
        captchaId: id,
        captchaCode: code,
      },
      force: false,
    });
  });

  await eufy.connect();
  winstonLogger.info("Connecting...");
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
process.on("uncaughtException", logErrorAndExit("uncaughtException"));
process.on("unhandledRejection", logErrorAndExit("unhandledRejection"));

main().catch(logErrorAndExit("uncaughted exception"));
