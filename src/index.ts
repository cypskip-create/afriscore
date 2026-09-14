import express from "express";
import { migrate } from "./db";
import businessRoutes from "./routes/businesses";
import consentRoutes from "./routes/consents";
import personRoutes from "./routes/persons";
import clientRoutes from "./routes/clients";
import businessDataRoutes from "./routes/businessData";
import webhookRoutes from "./routes/webhooks";

migrate();

const app = express();
app.use(express.json());

// --- API Gateway concerns ---
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
});

app.get("/v1/health", (_req, res) => res.json({ status: "ok", service: "africore", phase: 2 }));

app.use("/v1/businesses", businessRoutes);
app.use("/v1/businesses/:id", businessDataRoutes); // accounts/transactions/financial-profile
app.use("/v1/persons", personRoutes);
app.use("/v1/consents", consentRoutes);
app.use("/v1/clients", clientRoutes);
app.use("/v1/webhooks", webhookRoutes);

app.use((req, res) => res.status(404).json({ error: "not_found", path: req.originalUrl }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`AfriCore (Phase 2) listening on :${PORT}`);
});