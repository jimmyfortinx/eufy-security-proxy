import "./dotenv.ts";
import {
  EufySecurity,
  Device,
  CommandName,
  type EufySecurityConfig,
  type Station,
  P2PConnectionType,
  type P2PClientProtocol,
} from "eufy-security-client";
import { Logger } from "tslog";
import ffmpeg from "fluent-ffmpeg";
import net from "net";
import { captchas, getVerificationUrl, verification } from "./express.ts";
import LokiTransport from "winston-loki";
import { createLogger, format, transports } from "winston";
import winston from "winston/lib/winston/config/index.js";
import { flushAndExit, winstonLogger } from "./logger.ts";

let retryAttempt = 0;
let eufy: EufySecurity | undefined;

async function cleanup() {
  if (eufy !== undefined) {
    eufy.close();
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
const streams = new Map<string, ffmpeg.FfmpegCommand>();

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
  eufy.setLoggingLevel("all", 3);

  eufy.on("connection error", logErrorAndExit("connection error"));

  const start = async (stop?: boolean) => {
    if (eufy === undefined) {
      throw new Error("Undefined");
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

      if (stop) {
        await camera.stopLivestream(device);
      }
      await camera.startLivestream(device);
    } catch (error) {
      await logErrorAndExit("livestream start error")(error);
    }
  };

  (eufy as any as P2PClientProtocol).on(
    "livestream error",
    async (_, error) => {
      if (retryAttempt > 3) {
        await logErrorAndExit("livestream start error")(error);
      } else {
        await start(true);
      }
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

        if (!process.env.DISABLE_VIDEO) {
          const port = 8888;
          net
            .createServer((socket) =>
              videostream.on("data", (chunk) => socket.write(chunk))
            )
            .listen(port);
          command.videoCodec("copy").input(`tcp://localhost:${port}`);
        }

        if (!process.env.DISABLE_AUDIO) {
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
            ...(process.env.LOG_FFMPEG ? ["-loglevel debug"] : []),
          ]);

        if (process.env.LOG_FFMPEG) {
          command.on("stderr", function (stderrLine) {
            winstonLogger.info("Stderr output: " + stderrLine);
          });
        }

        streams.set(serial, command);

        command.on("error", logErrorAndExit("ffmpeg stream error")).run();

        clearTimeout(timeoutId);
        retryAttempt = 0;

        winstonLogger.info(`Proxying the camera ${serial} to ${output}...`);
      } catch (error) {
        winstonLogger.error(error);
        cleanup();
      }
    }
  );

  eufy.on("station livestream stop", async (station) => {
    const serial = station.getSerial();

    const stream = streams.get(serial);

    if (stream === undefined) {
      return;
    }

    stream.kill("SIGKILL");
  });

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

main().catch(logErrorAndExit("uncaughted exception"));
