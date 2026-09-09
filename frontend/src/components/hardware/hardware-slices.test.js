import { describe, expect, it } from 'vitest';

import rigReducer, {
    fetchRigs,
    setFormValues as setRigFormValues,
    submitOrEditRig,
} from './rig-slice.jsx';
import rotatorReducer, {
    deleteRotators,
    setFormValues as setRotatorFormValues,
    setOpenDeleteConfirm,
} from './rotator-slice.jsx';
import { DEFAULT_ROTATOR } from './rotator-edit-logic.js';
import sdrReducer, {
    fetchLocalAirspyDevices,
    fetchSDRs,
    setSelectedSDRId,
} from './sdr-slice.jsx';

describe('hardware slices', () => {
    it('merges, submits, and resets rig configuration state', () => {
        let state = rigReducer(undefined, { type: '@@INIT' });
        state = rigReducer(state, setRigFormValues({ name: 'IC-705', port: 4533 }));
        state = rigReducer(state, fetchRigs.pending('request'));
        state = rigReducer(state, fetchRigs.fulfilled([{ id: 'rig-1' }], 'request'));
        state = rigReducer(state, submitOrEditRig.fulfilled([{ id: 'rig-1' }], 'request'));

        expect(state.rigs).toEqual([{ id: 'rig-1' }]);
        expect(state.status).toBe('succeeded');
        expect(state.loading).toBe(false);
        expect(state.formValues).toMatchObject({ id: null, name: '', port: 4532 });
    });

    it('closes the rotator delete dialog on a successful deletion', () => {
        let state = rotatorReducer(undefined, { type: '@@INIT' });
        state = rotatorReducer(state, setRotatorFormValues({ name: 'Az/El', maxaz: 450 }));
        state = rotatorReducer(state, setOpenDeleteConfirm(true));
        state = rotatorReducer(state, deleteRotators.fulfilled([{ id: 'rot-2' }], 'request'));

        expect(state.rotators).toEqual([{ id: 'rot-2' }]);
        expect(state.openDeleteConfirm).toBe(false);
        expect(state.formValues).toMatchObject({ name: 'Az/El', maxaz: 450 });
    });

    it('uses Hamlib rotctld port 4533 for new rotators', () => {
        const state = rotatorReducer(undefined, { type: '@@INIT' });

        expect(DEFAULT_ROTATOR.port).toBe(4533);
        expect(state.formValues.port).toBe(4533);
    });

    it('selects fetched SDRs and records local-device request failures', () => {
        let state = sdrReducer(undefined, { type: '@@INIT' });
        state = sdrReducer(state, fetchSDRs.fulfilled([{ id: 'sdr-1', name: 'RTL-SDR' }], 'request'));
        state = sdrReducer(state, setSelectedSDRId('sdr-1'));
        state = sdrReducer(state, fetchLocalAirspyDevices.pending('request'));
        state = sdrReducer(state, fetchLocalAirspyDevices.rejected(null, 'request', undefined, 'no device'));

        expect(state.selectedSDR).toEqual({ id: 'sdr-1', name: 'RTL-SDR' });
        expect(state.loadingLocalAirspySDRs).toBe(false);
        expect(state.status).toBe('failed');
        expect(state.error).toBe('no device');
    });
});
