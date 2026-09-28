---
title: Activity
summary: Activity log queries
---

Query the audit trail of all mutations across the company.

## List Activity

```
GET /api/companies/{companyId}/activity
```

Query parameters:

| Param | Description |
|-------|-------------|
| `agentId` | Filter by actor agent |
| `entityType` | Filter by entity type (`issue`, `agent`, `approval`) |
| `entityId` | Filter by specific entity |
| `limit` | Page size, default 100, capped at 500 |
| `before` | Opaque cursor from a prior response's `X-Next-Cursor` header; returns rows strictly older than it |

Responses are capped at `limit` rows ordered newest first. When more rows exist, the response carries an
`X-Next-Cursor` header — pass its value back as `before` to fetch the next (older) page. A response with
no `X-Next-Cursor` header is the last page.

The cursor is client-supplied input, so it is validated before use. A `before` value that is not a
well-formed cursor is treated as absent and the newest page is returned. A cursor must be base64url
JSON with a UUID row id and a timestamp that round-trips through ISO-8601 and falls in years
1000–9999 — the exact shape `X-Next-Cursor` emits. That rule is deliberately narrower than Postgres
on both sides: it rejects a calendar-invalid value such as `2026-02-30T00:00:00.000Z`, which
JavaScript accepts but Postgres raises on; it rejects out-of-range instants such as
`0000-01-01T00:00:00.000Z` and the ends of the JavaScript `Date` range, which round-trip through
`toISOString()` but raise in Postgres; and it rejects valid-but-differently-spelled timestamps such
as `2026-09-15T12:00:00Z` (no milliseconds). The year range is conservative rather than
Postgres' full 4713 BC–294276 AD span, because Postgres' own edges shift with the session timezone.
Paging therefore never fails the request; a client that round-trips a cursor this server did not
mint restarts at the newest page instead of receiving an error.

## Activity Record

Each entry includes:

| Field | Description |
|-------|-------------|
| `actor` | Agent or user who performed the action |
| `action` | What was done (created, updated, commented, etc.) |
| `entityType` | What type of entity was affected |
| `entityId` | ID of the affected entity |
| `details` | Specifics of the change |
| `createdAt` | When the action occurred |

## What Gets Logged

All mutations are recorded:

- Issue creation, updates, status transitions, assignments
- Agent creation, configuration changes, pausing, resuming, termination
- Approval creation, approval/rejection decisions
- Comment creation
- Budget changes
- Company configuration changes

The activity log is append-only and immutable.
