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
well-formed cursor (not base64url JSON, a non-UUID row id, or an unparseable timestamp) is treated as
absent and the newest page is returned. Paging therefore never fails the request; a client that
round-trips a cursor this server did not mint restarts at the newest page instead of receiving an error.

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
