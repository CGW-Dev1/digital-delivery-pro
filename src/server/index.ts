import { createApp } from "./app";
import { config } from "./config";
import { getDb } from "./db";

getDb();

const app = createApp();

app.listen(config.port, () => {
  console.log(`API server listening on http://127.0.0.1:${config.port}`);
});
