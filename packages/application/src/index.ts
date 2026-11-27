import { DEFAULT_LOCALE, type LocaleCode } from "@prood/domain";
import {
  CONTRACT_VERSION,
  type DbDriverKind,
  type HealthResponse,
} from "@prood/contracts";

export * from "./id.js";
export * from "./persistence.js";

export interface Clock {
  now(): Date;
}

export interface DatabaseHealthPort {
  readonly driver: DbDriverKind;
  ping(): Promise<{ ok: true }>;
}

export interface HealthCheckDeps {
  clock: Clock;
  dbHealth: DatabaseHealthPort;
  locale?: LocaleCode;
}

/**
 * Pure application use case for health verification, independent of HTTP or DB driver.
 */
export function createHealthCheckUseCase(deps: HealthCheckDeps) {
  return async function getHealth(): Promise<HealthResponse> {
    await deps.dbHealth.ping();
    return {
      contractVersion: CONTRACT_VERSION,
      status: "ok",
      dbDriver: deps.dbHealth.driver,
      locale: deps.locale ?? DEFAULT_LOCALE,
      timestamp: deps.clock.now().toISOString(),
    };
  };
}
