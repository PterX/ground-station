# Tracker command lifecycle

The rotator island, rig island, and manual movement dialog share a command
registry. Desired tracking state is persisted in the existing DB; it does not
prove that hardware has applied an operation.

## Requests and events

`set-tracking-state` accepts a field patch in `value` and an `operation` object.
`move-rotator` and `stop-rotator` accept the operation metadata at the top level.
Metadata includes `command_id`, `tracker_id`, `action`, `device_ids`,
`accept_before`, and optional `supersedes`. State patches also carry
`expected_state` for optimistic concurrency checks on the fields being changed.

The browser creates the command ID before sending. The API returns the command
record under `data.command`; repeated requests with the same ID return that
record. Acknowledgement is acceptance, not completion. Stop preempts conflicting
work when the worker handles it and records cancellation tombstones for requests
that have not arrived yet. A failed Stop submission leaves existing work pending.
Ordinary conflicting requests are rejected. Separate rig and rotator resources
can progress independently.

`tracker-command-status` broadcasts complete command records, including revision,
scope(s), device identity, requested changes, action, timestamps and reason.
Statuses are `submitted`, `started`, `succeeded`, `failed`, `cancelled`, and
`unknown`. `sending` exists only in the browser. Terminal results cannot regress.

The worker receives an atomic context/operation envelope. It rejects expired
envelopes before applying state, explicitly reports execution/results, and never
uses unrelated partial telemetry as acknowledgement. Manual execution runs
before location and sky-target resolution. Rotator Stop disables tracking and
issues the controller's physical stop command.

Manual Move requires two fresh position samples within tolerance. Configured
parking similarly waits for arrival; native parking without position feedback
reports "Park command sent". Enabling tracking completes when the worker has
applied that mode; subsequent continuous tracking is hardware status, not a
permanently running UI command.

## Recovery and freshness

`tracker-hardware-state` carries independently sequenced hardware snapshots with
worker generation/start time, observation time, tracking state, rig and rotator
data. Partial legacy sky events cannot overwrite this hardware stream.

`get-tracker-commands` returns active/recent commands, server revision/epoch/time,
and hardware snapshots. Worker results also reconcile saved desired hardware
state, without overwriting a newer request. The browser reconciles on connection and every five
seconds while an operation is outstanding. Request acknowledgement times out
after eight seconds; requests not accepted within ten seconds are rejected.
The browser estimates server time from reconciliation snapshots when assigning
request deadlines, so ordinary browser/server clock skew does not expire requests.

Supervisor deadlines run separately from sky/VFO processing: 30 seconds for
state changes and 180 seconds for Move/Park. Missing execution results become
`unknown`; a cancellation is sent to prevent late queued work from running.
A running rotator operation receiving cancellation transitions to physical Stop.

The supervisor journals commands atomically beside the configured DB, using
`<database-stem>.commands.json`. It keeps the latest 500 terminal records plus
outstanding records. Hardware snapshots are refreshed by workers. After restart,
outstanding outcomes remain unknown, their hardware state is restored as
disconnected, and operations are never replayed. Fresh telemetry marks those old
unknown outcomes reconciled so new commands can be accepted. The UI continues
to explain that the previous execution result could not be confirmed.

Closing the manual dialog does not cancel movement. Progress is held in Redux
and remains visible when reopening; Stop is available while a movement is queued
or running. Uncertainty is shown explicitly instead of an endless spinner.

## Validation

Backend lifecycle and worker tests: `tests/testoperations.py` and
`tests/testmanualrotator.py`. Frontend reducer, request-ordering, and dialog tests:
`src/components/target/__tests__/tracker-commands.test.jsx`.
