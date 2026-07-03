# Distributed Job Scheduler

A production-inspired distributed job scheduling platform capable of reliably executing asynchronous background jobs across multiple workers. Built with Node.js, Express, and PostgreSQL.

## Core Features
* **Atomic Job Claiming:** Utilizes PostgreSQL's `SELECT ... FOR UPDATE SKIP LOCKED` to ensure jobs are claimed atomically without race conditions across multiple distributed workers.
* **Resilience & Retries:** Features configurable exponential backoff with jitter for failed jobs.
* **Dead Letter Queue (DLQ):** Jobs that exceed their maximum retry counts are safely moved to a DLQ with their error payloads for audit and debugging.
* **Real-time Dashboard:** A single-file React/Tailwind frontend to visualize queue health, worker status, and job executions.

## Tech Stack
* **Backend:** Node.js, Express.js
* **Database:** PostgreSQL, Prisma ORM
* **Frontend:** React (via CDN), Tailwind CSS

## Local Setup Instructions

### 1. Prerequisites
Ensure you have Node.js (v18+) and npm installed. You will also need a PostgreSQL database (local or cloud-hosted via Neon/Supabase).

### 2. Installation
Clone the repository and install the required dependencies:
\`\`\`bash
git clone https://github.com/sanyak-1/distributed-job-scheduler.git
cd distributed-job-scheduler
npm install
\`\`\`

### 3. Environment Configuration
Create a `.env` file in the root directory and add your PostgreSQL connection string:
\`\`\`env
DATABASE_URL="postgresql://user:password@host:port/dbname?sslmode=require"
\`\`\`

### 4. Database Setup
Apply the schema and generate the Prisma client:
\`\`\`bash
npx prisma migrate dev --name init
\`\`\`

### 5. Running the System
The system is divided into two separate processes: the API server and the Worker engine.

**Start the API Server:**
\`\`\`bash
node server.js
\`\`\`
*(Runs on port 3000 by default)*

**Start the Worker Engine:**
Open a new terminal window and run:
\`\`\`bash
node worker.js
\`\`\`

### 6. Accessing the Dashboard
To interact with the system, simply open the `index.html` file in any modern web browser. You will need to create a Queue in your database (via `npx prisma studio`) and input the Queue ID into the dashboard to start dispatching jobs.

## API Endpoints
* \`POST /api/jobs\` - Enqueue a new job (Immediate or Scheduled).
* \`GET /api/queues/:id/jobs\` - Fetch paginated jobs for a specific queue with optional status filtering.
* \`GET /api/queues/:id/metrics\` - Retrieve aggregate counts of job statuses (Pending, Running, Completed, Failed, Dead Letter).

erDiagram
    Organization ||--o{ Project : "has many"
    Project ||--o{ Queue : "has many"
    Queue ||--o{ Job : "contains"
    Queue ||--o{ DeadLetterQueue : "maintains"
    
    Job ||--o{ JobExecution : "records"
    Job |o--o| DeadLetterQueue : "moves to (on failure)"
    
    Worker ||--o{ JobExecution : "performs"

    Organization {
        String id PK
        String name
        DateTime createdAt
    }

    Project {
        String id PK
        String name
        String organizationId FK
    }

    Queue {
        String id PK
        String name
        String projectId FK
    }

    Job {
        String id PK
        String queueId FK
        Json payload
        Int priority
        String status
        Int retryCount
        Int maxRetries
        DateTime scheduledAt
    }

    JobExecution {
        String id PK
        String jobId FK
        String workerId FK
        String status
        Int attempt
    }

    DeadLetterQueue {
        String id PK
        String queueId FK
        String jobId FK
        Json payloadSnapshot
        String errorReason
    }

    Worker {
        String id PK
        String hostname
        Boolean isHealthy
    }
