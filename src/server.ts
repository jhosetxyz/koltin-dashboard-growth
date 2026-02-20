import "dotenv/config";
import express from "express";
import type { Request, Response } from "express";

const app = express();

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true, uptimeSeconds: Math.round(process.uptime()) });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Server listening on http://localhost:${port}`);
});

