# Phase 1 Implementation Notes

Decisions made where the spec was ambiguous, to record minimal-sensible choices.

## Column delete: item count check via service method

The spec says "caller must have already verified no items reference this column" before calling `ColumnService.delete()`. The route handler does this check. Rather than accessing the raw `db` from the route, a `countItems(id: string): number` method was added to `ColumnService`. This keeps SQL out of route files and is consistent with the service layer pattern. Not a design deviation — just plumbing.

## `PATCH /api/items/:id` with `parent_id` in body

The spec says `parent_id` is updated only if "present in the body". JavaScript `undefined` vs. `null` differ. The implementation checks `'parent_id' in body` (key presence) so that explicitly sending `null` sets the parent to null (unlinks), while omitting the key entirely leaves it unchanged. Sending `null` is a valid unlink operation.

## `PATCH /api/projects/:id` / `PATCH /api/items/:id` — empty body detection

The spec says return `400` if the body contains no recognised fields. The implementation parses the JSON body and counts how many recognised field keys are present in `updateData`. If zero, it returns 400. An entirely unparseable body (non-JSON) is treated as empty, also returning 400.

## Activity `next_before` calculation

The spec defines `next_before` as the `created_at` of the last entry on the current page, or `null` if the page is smaller than `limit`. This is implemented as: `entries.length < limit ? null : entries[entries.length - 1].created_at`. A page exactly equal to `limit` entries returns a `next_before`, which the caller uses to fetch the next page. If that next page is empty, the caller learns there was nothing more. This matches standard cursor-pagination behaviour.

## Nested route parameter access (Hono)

Hono does not automatically propagate parent path parameters (e.g. `:projectId`) into nested `app.route()` handlers. The nested handlers use `c.req.param('projectId')` which Hono resolves from the matched path when routes are mounted with `app.route('/api/projects/:projectId', nestedApp)`. Tested and confirmed working in all nested route files.

## UI: no routing library

Per spec, a single `selectedProjectId` piece of React state controls which view is shown. No react-router or similar. Navigation is purely conditional rendering in `App.tsx`.

## UI: status dropdown calls `/move` immediately on change

The spec describes the status dropdown calling `PATCH /api/items/:id/move` on change. There is no save/apply button for the status field — it fires immediately when the `<select>` value changes. This matches the spec's description.

## UI test tooling

The UI smoke test uses `@testing-library/react` and `vitest` with a jsdom environment. The API client is fully mocked with `vi.mock`. Only one test is written per spec instructions ("one smoke test that the app module renders is enough for now").

## Conversations/messages tables

Not created. A comment in `schema.ts` marks them as Phase 4 deferred.
