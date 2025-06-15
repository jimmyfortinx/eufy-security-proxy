import { createLogger, format, transports } from "winston";
import LokiTransport from "winston-loki";
import { setTimeout } from "timers/promises";
import { EOL } from "os";

if (process.env.LOKI_HOST === undefined) {
  throw new Error("LOKI_HOST environment variable is missing");
}

const myFormat = format.printf(({ level, message, stack }) => {
  return `${level}${message}${stack === undefined ? "" : `${EOL}${stack}`}`;
});

export const winstonLogger = createLogger({
  format: format.json(),
  transports: [
    new transports.Console({
      format: format.combine(format.cli(), myFormat),
    }),
    new LokiTransport({
      json: true,
      host: process.env.LOKI_HOST,
      labels: {
        service: "eufy-security-proxy",
        env: process.env.ENV ?? "development",
      },
      interval: 1,
      format: format.json(),
      onConnectionError(error) {
        console.error("CONNECTION ERROR", error);
      },
    }),
  ],
});

export async function flushAndExit(code?: number) {
  try {
    for (const transport of winstonLogger.transports) {
      if (typeof (transport as any).flush === "function") {
        await setTimeout(2000);
      }
    }
  } catch (e) {
    console.error("Error during logger flush", e);
  } finally {
    process.exit(code);
  }
}
