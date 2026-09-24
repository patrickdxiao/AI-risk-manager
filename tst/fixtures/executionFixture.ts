import { claimInvestigationExecution } from "../../src/core/investigation/investigationModel.js";
import type { UnitOfWorkPort } from "../../src/core/storageContracts.js";
import { investigationFixture } from "./investigationFixture.js";

/** Execution adds the claim operation to the same serialized test transaction. */
export function executionFixture(seed: Parameters<typeof investigationFixture>[0] = {}) {
  const fixture = investigationFixture(seed);
  const store: UnitOfWorkPort = {
    execute: (work) =>
      fixture.store.execute((context) =>
        work({
          ...context,
          investigations: {
            ...context.investigations,
            claimExecution: async (id, now, leaseUntil) => {
              if ((await context.investigations.findActive(now)) !== undefined) return undefined;
              const current = await context.investigations.findById(id);
              if (current === undefined) return undefined;
              const claimed = claimInvestigationExecution(current, { now, leaseUntil });
              await context.investigations.save(claimed);
              return claimed;
            },
          },
        }),
      ),
  };
  return { ...fixture, store };
}
