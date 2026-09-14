import express from "express";
import { migrate } from "./db";
import businessRoutes from "./routes/businesses";
import consentRoutes from "./routes/consents";

migrate();

const app = express();
app.use(express.json());

// --- API Gateway concerns (minimal for Phase 1) ---
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
});

app.get("/v1/health", (_req, res) => res.json({ status: "ok", service: "africore-identity", phase: 1 }));

app.use("/v1/businesses", businessRoutes);
app.use("/v1/consents", consentRoutes);

app.use((req, res) => res.status(404).json({ error: "not_found", path: req.originalUrl }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`AfriCore Identity (Phase 1) listening on :${PORT}`);
});