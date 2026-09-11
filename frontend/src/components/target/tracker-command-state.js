// Commands and hardware observations have separate lifecycles. A request ACK
// only confirms acceptance and can arrive after the worker's terminal event.
export const COMMAND_BUSY = ['sending', 'submitted', 'started', 'unknown'];
export const COMMAND_TERMINAL = ['succeeded', 'failed', 'cancelled'];

export function normalizeCommand(value) {
    return {
        ...value,
        commandId: value.command_id ?? value.commandId,
        trackerId: value.tracker_id ?? value.trackerId,
        scopes: value.scopes || (value.scope === 'tracking' ? ['rotator', 'rig', 'target'] : [value.scope]),
        requestedState: value.requested_state ? {
            rotatorState: value.requested_state.rotator_state,
            rigState: value.requested_state.rig_state,
        } : value.requestedState,
        submittedAt: value.submitted_at ? value.submitted_at * 1000 : value.submittedAt || Date.now(),
        updatedAt: value.updated_at ? value.updated_at * 1000 : value.updatedAt || Date.now(),
    };
}

export function mergeCommand(state, value) {
    const incoming = normalizeCommand(value);
    if (!incoming.commandId || !incoming.trackerId) return;
    const current = state.trackerCommandsById[incoming.commandId];
    // Order local sending states and server records on the browser's clock.
    // In particular, a new Stop must win before its acknowledgement arrives.
    incoming.submittedAt = current?.submittedAt ?? (incoming.submittedAt
        - (value.submitted_at ? state.trackerServerOffset || 0 : 0));
    // Completion feedback expires on the browser's clock, including results
    // restored from the server journal after reconnecting.
    if (value.updated_at) incoming.updatedAt -= state.trackerServerOffset || 0;
    if (current) {
        if (COMMAND_TERMINAL.includes(current.status)) return;
        if (incoming.revision && current.revision && (incoming.revision < current.revision || (incoming.revision === current.revision && current.status !== 'unknown'))) return;
        // Local uncertainty may be resolved by a newer authoritative snapshot.
        if (!incoming.revision && current.revision && incoming.status !== 'unknown') return;
        if (incoming.status === 'submitted' && current.status === 'started') return;
    }
    state.trackerCommandsById[incoming.commandId] = {...current, ...incoming};
}

export function selectTrackerCommand(commands, trackerId, scope, deviceId) {
    return Object.values(commands || {}).filter(command => (
        (command.trackerId === trackerId || (deviceId && command.device_ids?.[scope] === deviceId))
        && (!scope || command.scopes?.includes(scope))
    )).sort((left, right) => (
        Number(COMMAND_BUSY.includes(right.status) && !right.reconciled) - Number(COMMAND_BUSY.includes(left.status) && !left.reconciled)
        || (right.submittedAt || 0) - (left.submittedAt || 0)
    ))[0] || null;
}

export function commandPatch(data, current = {}) {
    const fields = ['norad_id', 'target_type', 'target_name', 'mission_id', 'command', 'body_id',
        'rotator_state', 'rig_state', 'group_id', 'rig_id', 'rotator_id', 'transmitter_id', 'rig_vfo', 'vfo1', 'vfo2'];
    return Object.fromEntries(fields.filter(key => data[key] !== undefined && data[key] !== current[key])
        .map(key => [key, data[key]]));
}

export function commandScopes(changes, action) {
    const scopes = [];
    if (action === 'move' || (action === 'stop' && !Object.keys(changes).length) || ['rotator_state', 'rotator_id'].some(key => key in changes)) scopes.push('rotator');
    if (['rig_state', 'rig_id', 'transmitter_id', 'rig_vfo', 'vfo1', 'vfo2'].some(key => key in changes)) scopes.push('rig');
    if (Object.keys(changes).some(key => !['rotator_state', 'rotator_id', 'rig_state', 'rig_id', 'transmitter_id', 'rig_vfo', 'vfo1', 'vfo2'].includes(key))) scopes.push('target');
    return scopes.length ? scopes : ['target'];
}

export function commandLabel(command) {
    if (!command) return '';
    if (command.status === 'unknown') return command.reconciled
        ? 'Previous outcome unconfirmed; current hardware state restored'
        : 'Status unknown — checking connection';
    if (command.status === 'sending') return 'Sending…';
    if (command.status === 'submitted') return 'Queued…';
    if (command.status === 'started') return ({move: 'Moving…', stop: 'Stopping…', park: 'Parking…',
        connect: 'Connecting…', disconnect: 'Disconnecting…', track: 'Starting tracking…'})[command.action] || 'Applying changes…';
    if (command.status === 'failed') return command.reason || 'Command failed';
    if (command.status === 'cancelled') return command.reason || 'Command cancelled';
    return command.reason || ({move: 'Position reached', stop: 'Stopped', park: 'Parked'})[command.action] || 'Command completed';
}

export function callTrackerApi(socket, cmd, data, timeout = 8000) {
    return new Promise((resolve, reject) => {
        if (!socket?.connected) {
            reject({message: 'Not connected to backend', uncertain: false});
            return;
        }
        // Do not buffer hardware actions for automatic transmission after reconnect.
        socket.timeout(timeout).emit('api.call', {cmd, data}, (error, response) => {
            if (error) reject({message: 'Acknowledgement missing; checking command status', uncertain: true});
            else if (!response?.success) reject({message: response?.message || response?.error || 'Command rejected', uncertain: false});
            else resolve(response.data);
        });
    });
}
