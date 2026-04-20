import { logger } from "./logger";

type StartupValidationResult = {
  ok: boolean;
  warnings: string[];
  errors: string[];
};

export function validateStartupEnvironment(): StartupValidationResult {
  const isProduction = process.env.NODE_ENV === "production";
  const warnings: string[] = [];
  const errors: string[] = [];

  const requiredInProduction = [
    "DATABASE_URL",
    "ADMIN_SECRET",
    "CORS_ALLOWED_ORIGINS",
  ] as const;

  for (const key of requiredInProduction) {
    const value = process.env[key];
    if (isProduction && (!value || value.trim() === "")) {
      errors.push(`Missing required env in production: ${key}`);
    }
  }

  if (isProduction && (!process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN.trim() === "")) {
    warnings.push("TELEGRAM_BOT_TOKEN is missing. Authentication will be disabled or fail-open.");
  }

  if (!process.env.REDIS_URL) {
    warnings.push("REDIS_URL is not set. Falling back to single-instance in-memory mode.");
  }

  if (!process.env.CORS_ALLOWED_ORIGINS) {
    warnings.push("CORS_ALLOWED_ORIGINS not set. Using localhost-only defaults.");
  }

  if (!process.env.LOG_LEVEL) {
    warnings.push("LOG_LEVEL not set. Defaulting to info.");
  }

  if (isProduction && !process.env.VITE_API_URL) {
    warnings.push("VITE_API_URL not set on server env. Ensure frontend deploy has API URL configured.");
  }

  return {
    ok: errors.length === 0,
    warnings,
    errors,
  };
}

export function runStartupValidation(): void {
  const result = validateStartupEnvironment();

  for (const warning of result.warnings) {
    logger.warn({ warning }, "Startup validation warning");
  }

  if (!result.ok) {
    for (const error of result.errors) {
      logger.error({ error }, "Startup validation error");
    }
    throw new Error("Startup environment validation failed.");
  }
}

export function logAndValidateStartupEnvironment(): void {
  runStartupValidation();
}
