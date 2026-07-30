import { createApp } from "./app.ts";
import { createDatabase } from "./db.ts";

const port = Number(process.env.CONDUCTOR_PORT ?? 4317);
const host = process.env.CONDUCTOR_HOST ?? "127.0.0.1";
const database = createDatabase();
database.backup();
const backupTimer = setInterval(() => database.backup(), 60 * 60_000);
backupTimer.unref();

const { app } = createApp(database);
const server = app.listen(port, host, () => {
  console.log(`Conductor API listening at http://${host}:${port}`);
});

function shutdown(signal: string) {
  console.log(`Received ${signal}; closing Conductor.`);
  server.close(() => {
    clearInterval(backupTimer);
    database.close();
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
