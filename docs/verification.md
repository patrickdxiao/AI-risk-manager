# Local verification

## HTTP latency

Run `pnpm benchmark` to build the app and measure real loopback HTTP requests against a temporary SQLite database.
The workload contains one sprint and 100 tasks in a dependency chain, with 20 warmups and 1,000 sequential measured requests per operation.
It includes authentication, HTTP transfer, and JSON parsing; task edits commit a new version.
The command removes its temporary state and never loads a provider or reads a monitored repository.

On an Apple M1 Pro, macOS Darwin 25.5.0, Node.js 26.8.1 (September 24, 2026):

| Operation       | p50     | p99      |
| --------------- | ------- | -------- |
| Status          | 1.65 ms | 4.70 ms  |
| List sprints    | 1.66 ms | 5.11 ms  |
| Sprint overview | 7.92 ms | 19.42 ms |
| Edit task       | 1.98 ms | 4.67 ms  |

These observations meet the design's 200 ms p50 / 1 s p99 planning and status targets for this fixture.
They do not measure cold startup, concurrent users, large evidence histories, model latency, or browser rendering, and are not a production latency guarantee.
Timing is reported rather than asserted in CI because machine load changes the results.

![Output from the local HTTP benchmark, including environment and sample counts](images/http-benchmark.png)
