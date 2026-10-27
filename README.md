# Seat Reservation API

A high-concurrency seat reservation engine built with TypeScript, Express, and PostgreSQL, designed to guarantee strict data correctness under heavy booking stampedes.

When thousands of users compete for the exact same seats the moment tickets go live, this system ensures seats are never double-sold, per-user purchasing quotas are strictly respected, and network retries are safely deduplicated.

---

## Key Features

- **Atomic Seat Locking**: Enforces deterministic row-level locks (`SELECT ... FOR UPDATE` ordered by seat number) to eliminate deadlocks and prevent race conditions.
- **Transactional Quota Enforcement**: Uses PostgreSQL advisory locks per user to prevent concurrent requests from bypassing booking limits.
- **User-Scoped Idempotency**: Safe retry semantics using client-provided keys cached in PostgreSQL with SHA-256 payload validation.
- **All-or-Nothing Multi-Seat Bookings**: Ensures composite orders succeed completely or rollback atomically—preventing partial holds.
- **Production Observability**: Structured JSON logging via Pino with correlation IDs (`x-request-id`) and Prometheus metrics (`/metrics`).
- **Liveness & Readiness Probes**: Kubernetes-native `/health/live` and `/health/ready` endpoints with active database ping checks.
- **Automated Stress Testing**: Built-in concurrency simulator verifying database invariants and business rules under burst load.

---

## Tech Stack

- **Runtime**: Node.js (v20+) with TypeScript
- **Framework**: Express 5
- **Database**: PostgreSQL 16
- **Data Integrity**: Zod schemas & PostgreSQL relational constraints
- **Telemetry**: Pino (structured logging), Prometheus client

---

## Prerequisites

- **Node.js**: v20 or higher
- **PostgreSQL**: v16 or higher (or Docker)

---

## Quick Start

### Option A: Running with Docker (Recommended)

1. Clone the repository and navigate into the project directory:
   ```bash
   git clone https://github.com/tapan241/seat-reservation-system.git
   cd seat-reservation-system
   ```

2. Start the API and database container:
   ```bash
   docker compose up --build
   ```

3. Verify the service is running:
   ```bash
   curl http://localhost:3000
   ```
   *Note: Database schema migrations run automatically on startup.*

### Option B: Local Setup (Without Docker)

1. Clone and install dependencies:
   ```bash
   git clone https://github.com/tapan241/seat-reservation-system.git
   cd seat-reservation-system
   npm install
   ```

2. Configure environment variables:
   ```bash
   cp .env.sample .env
   # Ensure DATABASE_URL in .env points to your running PostgreSQL instance
   ```

3. Initialize the database schema:
   ```bash
   npm run db:init
   ```

4. Start the development server:
   ```bash
   npm run dev
   ```

---

## API Reference

### Endpoints Overview

| Method | Endpoint | Authentication | Description |
|---|---|---|---|
| `GET` | `/` | None | API index and route directory |
| `GET` | `/health` | None | Service status and database connectivity check |
| `GET` | `/health/live` | None | Liveness probe (process alive) |
| `GET` | `/health/ready` | None | Readiness probe (database reachable) |
| `GET` | `/metrics` | None | Prometheus telemetry metrics |
| `POST` | `/shows` | Admin | Create a new show with seats and pricing |
| `GET` | `/shows/:id` | None | Get show details, seat map, and reconciliation invariant |
| `POST` | `/shows/:id/reserve` | User | Reserve one or more seats idempotently |
| `POST` | `/reservations/:id/cancel` | User (Owner) | Cancel an active reservation and release seats |

---

### Authentication

Authentication uses token headers (`Authorization: Bearer <token>`):
- **Admin**: Tokens starting with `admin_` (e.g., `Bearer admin_test`)
- **Regular User**: Any token string represents a unique user ID (e.g., `Bearer user_alice`). The user ID is extracted directly from the authorization context, never trusted from the request body.

---

### Endpoint Details & Examples

#### 1. Create a Show
Creates an event with a configured seat layout, ticket price, and user booking limit.

```bash
curl -X POST http://localhost:3000/shows \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer admin_test" \
  -d '{
    "name": "Concert Show",
    "price_paise": 25000,
    "per_user_limit": 4,
    "seats": ["A1", "A2", "A3", "A4", "A5"]
  }'
```

#### 2. Reserve Seats
Reserves specified seats for the authenticated user. Requires an `idempotency_key`.

```bash
curl -X POST http://localhost:3000/shows/<show_id>/reserve \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer user_alice" \
  -d '{
    "seats": ["A1", "A2"],
    "idempotency_key": "order_uuid_101"
  }'
```

- **All-or-Nothing**: If any requested seat is unavailable, the entire transaction rolls back (`409 Conflict`).
- **Quota Enforced**: Rejects bookings that exceed the show's `per_user_limit`.
- **Idempotent**: Re-sending the identical request returns the cached reservation response (`X-Idempotency-Cache: HIT`). Sending the same key with different seats returns `409 Conflict (IDEMPOTENCY_MISMATCH)`.

#### 3. Cancel a Reservation
Cancels an active booking and immediately releases the seats back to `"available"`.

```bash
curl -X POST http://localhost:3000/reservations/<reservation_id>/cancel \
  -H "Authorization: Bearer user_alice"
```

#### 4. Show State & Reconciliation
Returns show details, per-seat status array, and live inventory reconciliation.

```bash
curl http://localhost:3000/shows/<show_id>
```

Sample Response:
```json
{
  "show": {
    "id": "e0b9fc4e-a192-4f01-b841-f5cf17f69f21",
    "name": "Concert Show",
    "price_paise": 25000,
    "per_user_limit": 4
  },
  "reconciliation": {
    "available": 3,
    "confirmed": 2,
    "total_seats": 5,
    "is_valid": true
  },
  "seats": [
    { "seat_number": "A1", "status": "confirmed" },
    { "seat_number": "A2", "status": "confirmed" },
    { "seat_number": "A3", "status": "available" },
    { "seat_number": "A4", "status": "available" },
    { "seat_number": "A5", "status": "available" }
  ]
}
```

---

## Running the Stress Test

The repository includes a concurrency simulator that tests the system under burst conditions (hot-seat collisions, quota bypass stampedes, idempotency replays, and cancellation flows).

```bash
# Run against local server
npm run test:stress

# Or point directly to any host
npm run test:stress -- http://localhost:3000
```

### Configuration

Stress test parameters can be customized in `.env`:

| Variable | Default | Description |
|---|---|---|
| `STRESS_TOTAL_ROWS` | 10 | Seat layout row count (A-J) |
| `STRESS_SEATS_PER_ROW` | 10 | Seats per row |
| `STRESS_HOT_SEAT_USERS` | 20 | Number of concurrent users fighting over seat `A1` |
| `STRESS_QUOTA_USER_REQUESTS` | 10 | Concurrent requests from a single user attempting to exceed quota |
| `STRESS_RANDOM_USERS` | 100 | General concurrent bookings across random seats |

### Sample Output

```
--- Status Code Distribution ---
┌──────────────────────────────────┬────────┐
│ 201 (New Reservation)            │   48   │
│ 201 (Cached Replay)              │    4   │
│ 400 (Bad Request / Missing Seat) │    1   │
│ 409 (Seat Taken)                 │   86   │
│ 409 (Limit Exceeded)             │    6   │
│ 409 (Idempotency Mismatch)       │    1   │
│ 5xx (Server Error)               │    0   │
└──────────────────────────────────┴────────┘

--- Test Case Verdicts ---
Hot Seat Contention:        ✓ PASSED (1 winner, 19 declined)
Per-User Quota Limit:       ✓ PASSED (4 confirmed <= limit 4)
Idempotent Cache Replay:    ✓ PASSED (1 original, 4 cached hits)
Idempotency Payload Swap:   ✓ PASSED (payload mismatch rejected with 409)
All-or-Nothing Rollback:    ✓ PASSED (partial availability atomic rollback)
Non-Existent Seat Check:    ✓ PASSED (rejected with 400 Bad Request)
Cancellation & Re-booking:  ✓ PASSED (seat freed and booked by new user)
--------------------------
✓ ALL STRESS TESTS PASSED: All invariants hold, zero 500 errors.
```

---

## Observability

### Metrics (`/metrics`)
Prometheus counter and gauge metrics are exported out of the box:
- `reservations_confirmed_total`: Total number of successfully confirmed reservations.
- `reservations_declined_total{reason="..."}`: Rejections tagged by reason (`SEAT_ALREADY_TAKEN`, `USER_LIMIT_EXCEEDED`, `IDEMPOTENCY_MISMATCH`).
- `seats_available_current{show_id="..."}`: Gauge tracking real-time available seats per show.

### Structured Logging
Logs are emitted in JSON format via Pino. In development, logs format cleanly to stdout. Every incoming request receives a unique correlation ID (`x-request-id`) forwarded through all database and business logic logs.

---

## Architecture

For an in-depth explanation of the database transactions, concurrency locking model, advisory locks, and idempotency guarantees, see [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## Project Structure

```
seat-reservation-system/
├── src/
│   ├── constants/
│   │   └── enums.ts           # Status enums (seats, reservations)
│   ├── db/
│   │   ├── index.ts           # Configurable connection pool
│   │   ├── init.ts            # Database schema migration runner
│   │   ├── reset.ts           # Database wipe & reset utility
│   │   └── schema.sql         # DDL, indexes, and constraints
│   ├── middlewares/
│   │   ├── auth.ts            # Bearer token authentication & role checks
│   │   ├── errorHandler.ts    # Centralized error mapping & serialization
│   │   └── idempotency.ts     # User-scoped idempotency pre-check
│   ├── routes/
│   │   ├── reservations.ts    # Reservation cancellation endpoint
│   │   └── shows.ts           # Show creation, booking, and details endpoints
│   ├── scripts/
│   │   └── stress-test.ts     # High-concurrency stress test runner
│   ├── utils/
│   │   ├── logger.ts          # Pino logger setup
│   │   └── metrics.ts         # Prometheus metrics definitions
│   ├── schemas.ts             # Zod input validation schemas
│   ├── server.ts              # Express initialization, health probes, shutdown
│   └── types.ts               # Extended Express request types
├── Dockerfile                 # Multi-stage container build
├── docker-compose.yml         # Container orchestration (API + PostgreSQL)
├── ARCHITECTURE.md            # Concurrency & system design documentation
└── README.md                  # Project overview & usage guide
```

---

## Future Roadmap

- **Temporary Seat Leases**: Introduce time-boxed reservation holds (e.g., 10-minute cart hold) before final payment confirmation.
- **Idempotency Key TTL Eviction**: Background worker to periodically purge idempotency records older than 24 hours.
- **Distributed Rate Limiting**: Token-bucket rate limiting at the edge to throttle abusive clients prior to database transactions.
- **Real-Time Seat Maps**: Server-Sent Events (SSE) or WebSockets broadcasting seat status transitions directly to connected clients.
