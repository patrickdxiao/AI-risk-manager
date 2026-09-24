import type { ClockPort, IdGeneratorPort } from "../primitives.js";
import { RepositoryConflictError, type UnitOfWorkPort } from "../storageContracts.js";
import {
  createRepository,
  type Repository,
  type RepositoryInspectionPort,
} from "./repositoryModel.js";

export interface RegisterRepositoryInput {
  readonly path: string;
  readonly approvedRoot?: string;
  readonly stateDirectory: string;
}

/** Register an explicitly inspected repository independently of sprints and tasks. */
export class RegisterRepository {
  constructor(
    private readonly store: UnitOfWorkPort,
    private readonly inspector: RepositoryInspectionPort,
    private readonly ids: IdGeneratorPort,
    private readonly clock: ClockPort,
  ) {}

  /** Inspect outside the transaction; repeated registration never replaces a stored identity. */
  async execute(input: RegisterRepositoryInput): Promise<Repository> {
    const request = Object.freeze({ ...input });
    const inspected = await this.inspector.inspectRegistration(request);
    return this.store.execute(async ({ repositories }) => {
      const existing = (await repositories.list()).find(
        (repository) => repository.canonicalPath === inspected.canonicalRoot,
      );
      if (existing !== undefined) {
        if (existing.identityDigest !== inspected.identityDigest)
          throw new RepositoryConflictError("canonical_path", inspected.canonicalRoot);
        return existing;
      }
      const repository = createRepository({
        id: this.ids.next(),
        canonicalPath: inspected.canonicalRoot,
        gitRoot: inspected.canonicalRoot,
        ...(request.approvedRoot === undefined ? {} : { approvedRoot: request.approvedRoot }),
        identityDigest: inspected.identityDigest,
        registeredAt: this.clock.now(),
      });
      await repositories.add(repository);
      return repository;
    });
  }
}
