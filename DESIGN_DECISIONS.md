# Architecture & Design Decisions

This document outlines the core technical trade-offs and architectural decisions made while building the Distributed Job Scheduler.

## 1. Concurrency & Locking Strategy
**The Problem:** In a distributed system with multiple worker nodes polling a single database, there is a high risk of "race conditions"—two workers grabbing the same pending job simultaneously, leading to duplicate executions.
**The Solution:** We utilized PostgreSQL's `SELECT ... FOR UPDATE SKIP LOCKED` inside a Prisma `$transaction`. 
* **Why this works:** When a worker searches for the next available job, `FOR UPDATE` places a row-level lock on it. `SKIP LOCKED` ensures that if Worker B queries the database a millisecond later, it instantly skips the row Worker A is looking at and grabs the next one. This guarantees atomic job claiming without creating database bottlenecks or requiring external tools like Redis.

## 2. Database Indexing for Polling Speed
**The Problem:** Workers poll the database constantly. A full table scan on a `Job` table with millions of rows would crash the database.
**The Solution:** We implemented a composite index on `(status, scheduledAt)`.
* **Why this works:** The worker's polling query specifically looks for `WHERE status IN ('PENDING', 'SCHEDULED') AND scheduledAt <= now() ORDER BY priority`. The composite index allows the database engine to locate these exact rows in milliseconds, completely bypassing the rest of the table.

## 3. Resilience: Backoff and Dead Letter Queue (DLQ)
**The Problem:** Network requests fail. If a job fails, trying it again instantly will likely result in another failure. If it fails forever, it clogs the queue.
**The Solution:** Exponential Backoff with Jitter and a Dead Letter Queue.
* **Why this works:** On failure, `retryCount` increments. The next execution time is delayed exponentially (e.g., 2s, 4s, 8s) with a randomized "jitter" to prevent retry storms. If the job exceeds `maxRetries`, it is atomically moved to a `DEAD_LETTER` status, and a snapshot of the payload and error is saved to the `DeadLetterQueue` table. This preserves the audit trail while keeping the main queue clean.

## 4. Separation of Concerns (MVC Architecture)
**The Problem:** Mixing API routing, database logic, and worker processing creates monolithic, untestable code.
**The Solution:** Strict separation.
* **API Layer:** Separated into `routes/` and `controllers/`. Uses structured error handling (`AppError`) to prevent leaking stack traces.
* **Worker Engine:** Operates entirely independently of the Express server. It only requires a database connection to function, meaning it can be scaled horizontally across different servers.
