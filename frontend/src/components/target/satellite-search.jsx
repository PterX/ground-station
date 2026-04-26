import * as React from "react";
import {useSocket} from "../common/socket.jsx";
import {Fragment} from "react";
import { toast } from "../../utils/toast-with-timestamp.jsx";
import Autocomplete from "@mui/material/Autocomplete";
import {Box, CircularProgress, Divider, Paper, TextField, Typography} from "@mui/material";
import { useTranslation } from 'react-i18next';


const SatelliteSearchAutocomplete = React.memo(function SatelliteSearchAutocomplete({
    onSatelliteSelect,
    disabled = false,
}) {
    const {socket} = useSocket();
    const { t } = useTranslation('target');
    const [open, setOpen] = React.useState(false);
    const [options, setOptions] = React.useState([]);
    const [loading, setLoading] = React.useState(false);
    const retargetHint = t('satellite_search.retarget_hint', {
        defaultValue: 'Selecting a result will immediately retarget the active target.'
    });

    const search = (keyword) => {
        (async () => {
            setLoading(true);
            socket.emit("data_request", "get-satellite-search", keyword, (response) => {
                if (response.success) {
                    setOptions(response.data);
                } else {
                    console.error(response.error);
                    toast.error(`Error searching for satellites: ${response.error}`, {
                        autoClose: 5000,
                    });
                    setOptions([]);
                }
                setLoading(false);
            });
        })();
    };

    const handleOpen = () => {
        if (disabled) {
            return;
        }
        setOpen(true);
    };

    const handleClose = (event, reason) => {
        setOpen(false);
        if (reason !== 'selectOption') {
            setOptions([]);
        }
    };

    const handleInputChange = (event, newInputValue, reason) => {
        if (disabled) {
            return;
        }
        if (reason !== 'input') {
            return;
        }
        if (newInputValue.length > 2) {
            search(newInputValue);
        } else {
            setOptions([]);
        }
    };

    const handleOptionSelect = (event, selectedSatellite, reason) => {
        if (disabled) {
            return;
        }
        if (reason !== 'selectOption' || selectedSatellite === null) {
            return;
        }
        onSatelliteSelect({
            ...selectedSatellite,
            id: selectedSatellite['norad_id'],
        });
        setOpen(false);
        setOptions([]);
    };

    React.useEffect(() => {
        if (!disabled) {
            return;
        }
        setOpen(false);
        setOptions([]);
        setLoading(false);
    }, [disabled]);

    return (
        <Autocomplete
            size="small"
            sx={{ minWidth: 200, margin: 0 }}
            disabled={disabled}
            open={open}
            fullWidth={true}
            onOpen={handleOpen}
            onClose={handleClose}
            onInputChange={handleInputChange}
            onChange={handleOptionSelect}
            isOptionEqualToValue={(option, value) => option?.norad_id === value?.norad_id}
            getOptionLabel={(option) => {
                return `${option['norad_id']} - ${option['name']}`;
            }}
            options={options}
            loading={loading}
            PaperComponent={(paperProps) => (
                <Paper {...paperProps}>
                    <Box sx={{ px: 1.5, py: 1 }}>
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', lineHeight: 1.25 }}>
                            {retargetHint}
                        </Typography>
                    </Box>
                    <Divider />
                    {paperProps.children}
                </Paper>
            )}
            renderInput={(params) => (
                <TextField
                    size="small"
                    fullWidth={true}
                    disabled={disabled}
                    {...params}
                    label={t('satellite_search.search_label')}
                    slotProps={{
                        input: {
                            ...params.InputProps,
                            endAdornment: (
                                <Fragment>
                                    {loading ? <CircularProgress color="inherit" size={20} /> : null}
                                    {params.InputProps.endAdornment}
                                </Fragment>
                            ),
                        },
                    }}
                />
            )}
        />
    );
});

export default SatelliteSearchAutocomplete;
